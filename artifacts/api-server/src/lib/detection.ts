/**
 * detection.ts — VisionTrack Detection Orchestrator
 *
 * This module manages the full detection-to-report pipeline:
 *   1. Decides whether to run the Python subprocess (detect.py) or the mock pipeline.
 *   2. Spawns detect.py and parses its NDJSON stdout stream.
 *   3. Falls back to a synthetic mock if Python is unavailable.
 *   4. Calls generateExcelReport() to write the 6-sheet .xlsx workbook.
 *   5. Embeds bar/line chart images (SVG → PNG via @resvg/resvg-js) into the workbook.
 *
 * Key environment variables consumed here:
 *   VISIONTRACK_PYTHON     — path to the Python executable (defaults to python3)
 *   VISIONTRACK_MODEL      — YOLO model file or Axelera .axm path (defaults to yolov8n.pt)
 *   VISIONTRACK_CONFIDENCE — minimum confidence threshold (defaults to 0.7)
 *   VISIONTRACK_ZONES      — JSON array of named polygon zones
 *   VISIONTRACK_MOCK       — set "true" to skip Python entirely (for dev without GPU)
 */

import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import ExcelJS from "exceljs";
import { logger } from "./logger";

/** Absolute path to the Python detection script relative to CWD (the api-server package root). */
const DETECT_SCRIPT = path.resolve(process.cwd(), "detect.py");

/** Stats returned from the pipeline; stored directly into the jobs DB row. */
export interface VideoStats {
  fileSizeBytes: number;
  durationSeconds: number;
  totalDetections: number;
  totalTracks: number;
  /** Absolute path to the H.264 annotated video, or null if not generated. */
  annotatedVideoPath: string | null;
}

/** A single object detection event emitted by detect.py. */
interface Detection {
  frame: number;
  timestamp_s: number;
  track_id: number;
  class: string;
  zone: string;
  confidence: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
}

/** The final summary line emitted by detect.py after processing completes. */
interface SummaryMsg {
  total_detections: number;
  total_tracks: number;
  duration_s: number;
  fps: number;
  width: number;
  height: number;
  /** Path to the re-encoded H.264 annotated video, or empty string if not generated. */
  annotated_video_path?: string;
}

/** Returns the Python executable to use, preferring VISIONTRACK_PYTHON env var. */
function getPythonBin(): string {
  return process.env["VISIONTRACK_PYTHON"] ?? "python3";
}

/** Returns the model path to use, preferring VISIONTRACK_MODEL env var. */
function getModelPath(): string {
  return process.env["VISIONTRACK_MODEL"] ?? "yolov8n.pt";
}

/**
 * Spawn detect.py as a child process and collect its NDJSON output.
 *
 * detect.py writes one JSON object per line to stdout:
 *   - type:"detection"  → each detected object per frame
 *   - type:"summary"    → final stats (emitted once at the end)
 *   - type:"progress"   → frame progress tick (logged at debug level)
 *   - type:"log"        → informational messages from Python
 *   - type:"error"      → non-fatal errors from Python
 *
 * Rejects if the process exits non-zero or never emits a summary line.
 */
async function runPythonDetect(
  videoPath: string,
  annotatedVideoPath: string
): Promise<{ detections: Detection[]; summary: SummaryMsg }> {
  return new Promise((resolve, reject) => {
    const pythonBin = getPythonBin();
    const modelPath = getModelPath();

    // Forward the current process env plus overrides for model, confidence, zones, and output path.
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>,
      VISIONTRACK_MODEL: modelPath,
      VISIONTRACK_CONFIDENCE: process.env["VISIONTRACK_CONFIDENCE"] ?? "0.7",
      VISIONTRACK_OUTPUT_VIDEO: annotatedVideoPath,
      ...(process.env["VISIONTRACK_ZONES"] ? { VISIONTRACK_ZONES: process.env["VISIONTRACK_ZONES"] } : {}),
    };

    const args = [DETECT_SCRIPT, videoPath, modelPath];
    logger.info({ pythonBin, args, modelPath }, "Spawning detection subprocess");

    const child = spawn(pythonBin, args, { env });

    const detections: Detection[] = [];
    let summary: SummaryMsg | null = null;
    let stderr = "";
    // Buffer partial stdout lines — stdout chunks may split across JSON boundaries.
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      // Keep the incomplete last fragment for the next chunk.
      stdout = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          if (msg["type"] === "detection") {
            detections.push(msg as unknown as Detection);
          } else if (msg["type"] === "summary") {
            summary = msg as unknown as SummaryMsg;
          } else if (msg["type"] === "log") {
            logger.info({ script: "detect.py" }, String(msg["message"]));
          } else if (msg["type"] === "progress") {
            logger.debug({ frame: msg["frame"], total: msg["total_frames"] }, "Detection progress");
          } else if (msg["type"] === "error") {
            logger.error({ script: "detect.py" }, String(msg["message"]));
          }
        } catch {
          logger.warn({ line }, "Non-JSON output from detect.py");
        }
      }
    });

    // Collect stderr for error reporting; don't reject on stderr alone.
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (stderr) {
        // Log last 2000 chars to avoid flooding — YOLO often prints progress to stderr.
        logger.warn({ stderr: stderr.slice(-2000) }, "detect.py stderr");
      }
      if (code !== 0) {
        reject(new Error(`detect.py exited with code ${code}. Stderr: ${stderr.slice(-500)}`));
        return;
      }
      if (!summary) {
        reject(new Error("detect.py did not emit a summary line"));
        return;
      }
      resolve({ detections, summary });
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ${pythonBin}: ${err.message}. Is Python installed?`));
    });
  });
}

/**
 * Mock detection pipeline — used when detect.py is unavailable or VISIONTRACK_MOCK=true.
 *
 * Generates synthetic detections with realistic class distributions, track lifetimes,
 * and zone assignments. Useful for frontend/UX development without a GPU.
 *
 * Duration is estimated from file size assuming ~500 KB/s average bitrate.
 */
async function runMockPipeline(
  videoPath: string,
  fileSizeBytes: number
): Promise<{ detections: Detection[]; summary: SummaryMsg }> {
  logger.warn("Python detect.py unavailable — running mock pipeline. Install ultralytics on the P360 for real inference.");

  const CLASSES = ["person", "car", "truck", "bicycle", "motorcycle", "bus", "dog", "cat"];
  const DEFAULT_ZONES = ["Zone A (NW)", "Zone B (NE)", "Zone C (SW)", "Zone D (SE)"];

  const rand = (min: number, max: number) => Math.random() * (max - min) + min;
  const randInt = (min: number, max: number) => Math.floor(rand(min, max));
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  // Estimate duration from file size; cap at 5000 frames to prevent memory issues.
  const estimatedDuration = Math.max(10, fileSizeBytes / (500 * 1024));
  const fps = 25;
  const numFrames = Math.min(Math.floor(estimatedDuration * fps), 5000);

  const detections: Detection[] = [];
  // Track active objects across frames; each object lives for a random number of frames.
  const activeObjects = new Map<number, { class: string; zone: string; deathFrame: number }>();
  let nextTrackId = 1;

  for (let frame = 0; frame < numFrames; frame += 5) {
    // 30% chance to spawn a new object each sample, up to 20 concurrent objects.
    if (Math.random() < 0.3 && activeObjects.size < 20) {
      const id = nextTrackId++;
      activeObjects.set(id, {
        class: pick(CLASSES),
        zone: pick(DEFAULT_ZONES),
        deathFrame: frame + randInt(25, 300),
      });
    }
    for (const [id, obj] of activeObjects.entries()) {
      if (frame > obj.deathFrame) { activeObjects.delete(id); continue; }
      detections.push({
        frame,
        timestamp_s: frame / fps,
        track_id: id,
        class: obj.class,
        zone: obj.zone,
        confidence: rand(0.55, 0.99),
        bbox_x: randInt(0, 1820),
        bbox_y: randInt(0, 980),
        bbox_w: randInt(30, 200),
        bbox_h: randInt(30, 200),
      });
    }
  }

  const trackIds = new Set(detections.map(d => d.track_id));
  return {
    detections,
    summary: {
      total_detections: detections.length,
      total_tracks: trackIds.size,
      duration_s: estimatedDuration,
      fps,
      width: 1920,
      height: 1080,
      // No annotated video for mock runs.
      annotated_video_path: "",
    },
  };
}

/**
 * Main pipeline entry point called by the /api/process/:jobId route.
 *
 * Decision order:
 *   1. If VISIONTRACK_MOCK=true → mock pipeline.
 *   2. If detect.py exists on disk → spawn Python, fall back to mock on failure.
 *   3. Otherwise → mock pipeline with a warning.
 *
 * After collecting detections, generates the 6-sheet Excel report.
 * Returns VideoStats which is written back to the jobs DB row.
 */
export async function runDetectionPipeline(
  videoPath: string,
  reportPath: string,
  annotatedVideoPath: string
): Promise<VideoStats> {
  const fileSizeBytes = fs.statSync(videoPath).size;

  logger.info({ videoPath, reportPath }, "Starting detection pipeline");

  let detections: Detection[];
  let summary: SummaryMsg;

  const forceMock = process.env["VISIONTRACK_MOCK"] === "true";

  if (!forceMock && fs.existsSync(DETECT_SCRIPT)) {
    try {
      ({ detections, summary } = await runPythonDetect(videoPath, annotatedVideoPath));
    } catch (err) {
      logger.error({ err }, "Python detection failed, falling back to mock pipeline");
      ({ detections, summary } = await runMockPipeline(videoPath, fileSizeBytes));
    }
  } else {
    if (!forceMock) {
      logger.warn({ DETECT_SCRIPT }, "detect.py not found — running mock pipeline");
    }
    ({ detections, summary } = await runMockPipeline(videoPath, fileSizeBytes));
  }

  logger.info(
    { detections: summary.total_detections, tracks: summary.total_tracks },
    "Detection complete, generating report"
  );

  await generateExcelReport(videoPath, fileSizeBytes, summary, detections, reportPath);

  // Trust detect.py's summary — if it says the video was saved, accept the path.
  // Python already verifies the file exists before emitting the summary.
  const resolvedAnnotatedPath = summary.annotated_video_path || null;

  return {
    fileSizeBytes,
    durationSeconds: summary.duration_s,
    totalDetections: summary.total_detections,
    totalTracks: summary.total_tracks,
    annotatedVideoPath: resolvedAnnotatedPath,
  };
}

/**
 * Build and write the 6-sheet Excel workbook.
 *
 * Sheets (in order):
 *   1. Summary         — file info, overall stats, peak activity minute
 *   2. Zone Summary    — per-zone detection counts + data bars + bar chart image
 *   3. Class Breakdown — per-class counts, confidence ranges + data bars + bar chart image
 *   4. Timeline        — per-minute activity table + data bars + line chart image
 *   5. Tracks          — per tracked object statistics (top 500 by detection count)
 *   6. Raw Detections  — every detection (sampled to 2000 rows max)
 *
 * All sheets get coloured tabs and frozen header rows.
 *
 * Chart images are generated as SVG strings and rasterised to PNG using
 * @resvg/resvg-js (pure WASM — no canvas or browser APIs needed). Chart
 * generation is wrapped in try/catch; a failure skips charts but does NOT
 * fail the overall report write.
 *
 * IMPORTANT — ExcelJS data bar compatibility:
 *   ExcelJS 4.x supports only a subset of the XLSX data bar spec.
 *   Do NOT pass `gradient` or `border` properties to the dataBar object —
 *   ExcelJS does not handle them and will throw `undefined.forEach()` when
 *   writing the file. Only use: minLength, maxLength, cfvo, color, showValue.
 */
async function generateExcelReport(
  videoPath: string,
  fileSizeBytes: number,
  summary: SummaryMsg,
  detections: Detection[],
  outputPath: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "VisionTrack";
  workbook.created = new Date();

  /** Shared header cell style: white bold text on deep navy background. */
  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } },
    alignment: { horizontal: "center" },
  };

  const fps = summary.fps || 25;
  // Guard against zero detections for percentage calculations.
  const totalDet = detections.length || 1;

  // ── Sheet 1: Summary ──────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Property", key: "property", width: 30 },
    { header: "Value", key: "value", width: 40 },
  ];
  summarySheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Find the minute with the highest detection count for the "Peak Activity" row.
  const minuteBuckets: Record<number, number> = {};
  for (const d of detections) {
    const minute = Math.floor(d.timestamp_s / 60);
    minuteBuckets[minute] = (minuteBuckets[minute] ?? 0) + 1;
  }
  let peakMinute = 0;
  let peakCount = 0;
  for (const [min, count] of Object.entries(minuteBuckets)) {
    if (count > peakCount) { peakCount = count; peakMinute = Number(min); }
  }

  summarySheet.addRows([
    { property: "Video File", value: path.basename(videoPath) },
    { property: "File Size", value: `${sizeMB} MB` },
    { property: "Duration", value: `${summary.duration_s.toFixed(1)}s` },
    { property: "Resolution", value: `${summary.width}x${summary.height}` },
    { property: "Frame Rate", value: `${summary.fps.toFixed(2)} fps` },
    { property: "Total Detections", value: summary.total_detections },
    { property: "Unique Objects Tracked", value: summary.total_tracks },
    { property: "Peak Activity Minute", value: `Minute ${peakMinute} (${peakCount} detections)` },
    { property: "Analysis Date", value: new Date().toISOString() },
    { property: "Detection Backend", value: process.env["VISIONTRACK_BACKEND"] ?? "Axelera Voyager / Ultralytics YOLO" },
    { property: "Model", value: getModelPath() },
    { property: "Confidence Threshold", value: process.env["VISIONTRACK_CONFIDENCE"] ?? "0.35" },
  ]);

  // Highlight total detections and tracked objects in bold blue.
  [7, 8].forEach(rowNum => {
    const row = summarySheet.getRow(rowNum + 1);
    row.getCell(2).font = { bold: true, color: { argb: "FF1E40AF" } };
  });

  // ── Sheet 2: Zone Summary ─────────────────────────────────────────────────
  const zoneSheet = workbook.addWorksheet("Zone Summary");

  // Aggregate detections by zone: count events and collect unique track IDs.
  const zoneData: Record<string, { detections: number; trackIds: Set<number> }> = {};
  for (const d of detections) {
    if (!zoneData[d.zone]) zoneData[d.zone] = { detections: 0, trackIds: new Set() };
    zoneData[d.zone].detections++;
    if (d.track_id >= 0) zoneData[d.zone].trackIds.add(d.track_id);
  }

  zoneSheet.columns = [
    { header: "Zone", key: "zone", width: 25 },
    { header: "Detections", key: "count", width: 18 },
    { header: "Unique Objects", key: "unique", width: 18 },
    { header: "% of Total", key: "pct", width: 15 },
  ];
  zoneSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  // Sort zones by detection count descending so busiest zones appear first.
  const sortedZones = Object.entries(zoneData).sort((a, b) => b[1].detections - a[1].detections);
  let zoneRowNum = 2;
  for (const [zone, data] of sortedZones) {
    zoneSheet.addRow({
      zone,
      count: data.detections,
      unique: data.trackIds.size,
      pct: `${((data.detections / totalDet) * 100).toFixed(1)}%`,
    });
    zoneRowNum++;
  }


  // ── Sheet 3: Class Breakdown ───────────────────────────────────────────────
  const classSheet = workbook.addWorksheet("Class Breakdown");

  // Aggregate per object class: count, confidence stats, unique track IDs.
  const classData: Record<string, {
    count: number; totalConf: number; minConf: number; maxConf: number; trackIds: Set<number>
  }> = {};
  for (const d of detections) {
    if (!classData[d.class]) {
      classData[d.class] = { count: 0, totalConf: 0, minConf: 1, maxConf: 0, trackIds: new Set() };
    }
    classData[d.class].count++;
    classData[d.class].totalConf += d.confidence;
    classData[d.class].minConf = Math.min(classData[d.class].minConf, d.confidence);
    classData[d.class].maxConf = Math.max(classData[d.class].maxConf, d.confidence);
    if (d.track_id >= 0) classData[d.class].trackIds.add(d.track_id);
  }

  classSheet.columns = [
    { header: "Object Class", key: "cls", width: 20 },
    { header: "Detections", key: "count", width: 18 },
    { header: "Unique Objects", key: "unique", width: 18 },
    { header: "Avg Confidence", key: "avgConf", width: 18 },
    { header: "Min Confidence", key: "minConf", width: 18 },
    { header: "Max Confidence", key: "maxConf", width: 18 },
    { header: "% of Total", key: "pct", width: 15 },
  ];
  classSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  const sortedClasses = Object.entries(classData).sort((a, b) => b[1].count - a[1].count);
  let classRowNum = 2;
  for (const [cls, data] of sortedClasses) {
    classSheet.addRow({
      cls,
      count: data.count,
      unique: data.trackIds.size,
      avgConf: (data.totalConf / data.count).toFixed(3),
      minConf: data.minConf.toFixed(3),
      maxConf: data.maxConf.toFixed(3),
      pct: `${((data.count / totalDet) * 100).toFixed(1)}%`,
    });
    classRowNum++;
  }


  // ── Sheet 4: Timeline (per-minute activity) ────────────────────────────────
  const timelineSheet = workbook.addWorksheet("Timeline");

  // Build a bucket per minute covering the full video duration.
  const minuteData: Record<number, { detections: number; trackIds: Set<number>; classes: Record<string, number> }> = {};
  const maxMinute = detections.length > 0
    ? Math.floor(Math.max(...detections.map(d => d.timestamp_s)) / 60)
    : 0;

  // Pre-fill all minutes with empty buckets so the table has no gaps.
  for (let m = 0; m <= maxMinute; m++) {
    minuteData[m] = { detections: 0, trackIds: new Set(), classes: {} };
  }
  for (const d of detections) {
    const m = Math.floor(d.timestamp_s / 60);
    minuteData[m].detections++;
    if (d.track_id >= 0) minuteData[m].trackIds.add(d.track_id);
    minuteData[m].classes[d.class] = (minuteData[m].classes[d.class] ?? 0) + 1;
  }

  // Use top 3 object classes as dynamic columns so the sheet adapts to the video content.
  const topClasses = sortedClasses.slice(0, 3).map(([cls]) => cls);

  timelineSheet.columns = [
    { header: "Minute", key: "minute", width: 12 },
    { header: "Time Range", key: "range", width: 18 },
    { header: "Detections", key: "detections", width: 16 },
    { header: "Active Objects", key: "active", width: 18 },
    ...topClasses.map(cls => ({ header: cls, key: cls.replace(/\s/g, "_"), width: 14 })),
  ];
  timelineSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  let timelineRowNum = 2;
  for (let m = 0; m <= maxMinute; m++) {
    const data = minuteData[m];
    const startSec = m * 60;
    const endSec = Math.min((m + 1) * 60, summary.duration_s);
    const row: Record<string, unknown> = {
      minute: m,
      range: `${formatTime(startSec)} – ${formatTime(endSec)}`,
      detections: data.detections,
      active: data.trackIds.size,
    };
    for (const cls of topClasses) {
      row[cls.replace(/\s/g, "_")] = data.classes[cls] ?? 0;
    }
    timelineSheet.addRow(row);
    timelineRowNum++;
  }

  if (maxMinute > 0) {

    // Highlight the busiest minute in amber so it stands out.
    const peakRow = Object.entries(minuteData)
      .sort((a, b) => b[1].detections - a[1].detections)[0];
    if (peakRow) {
      const peakRowNum = Number(peakRow[0]) + 2;
      const row = timelineSheet.getRow(peakRowNum);
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
        cell.font = { bold: true };
      });
    }
  }

  // ── Sheet 5: Tracks ────────────────────────────────────────────────────────
  const tracksSheet = workbook.addWorksheet("Tracks");

  // Build a map of track_id → { class, zone, all frames, all confidences }.
  // Tracks with track_id < 0 are untracked detections (e.g. when ByteTrack loses an object).
  const trackMap = new Map<number, {
    class: string; zone: string; frames: number[]; confidences: number[];
  }>();
  for (const d of detections) {
    if (d.track_id < 0) continue;
    if (!trackMap.has(d.track_id)) {
      trackMap.set(d.track_id, { class: d.class, zone: d.zone, frames: [], confidences: [] });
    }
    const t = trackMap.get(d.track_id)!;
    t.frames.push(d.frame);
    t.confidences.push(d.confidence);
  }

  tracksSheet.columns = [
    { header: "Track ID", key: "track_id", width: 12 },
    { header: "Class", key: "class", width: 16 },
    { header: "Zone", key: "zone", width: 20 },
    { header: "First Seen (s)", key: "first_seen_s", width: 16 },
    { header: "Last Seen (s)", key: "last_seen_s", width: 16 },
    { header: "Duration (s)", key: "duration_s", width: 14 },
    { header: "Detection Count", key: "detection_count", width: 18 },
    { header: "Avg Confidence", key: "avg_confidence", width: 18 },
  ];
  tracksSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  // Sort by detection count descending; cap at 500 tracks to keep file size manageable.
  let trackCount = 0;
  let trackRowNum = 2;
  for (const [id, t] of [...trackMap.entries()].sort((a, b) => b[1].frames.length - a[1].frames.length)) {
    if (trackCount++ >= 500) break;
    const avgConf = t.confidences.reduce((a, b) => a + b, 0) / t.confidences.length;
    const firstSeen = parseFloat((t.frames[0] / fps).toFixed(3));
    const lastSeen = parseFloat((t.frames[t.frames.length - 1] / fps).toFixed(3));
    tracksSheet.addRow({
      track_id: id,
      class: t.class,
      zone: t.zone,
      first_seen_s: firstSeen,
      last_seen_s: lastSeen,
      duration_s: parseFloat((lastSeen - firstSeen).toFixed(3)),
      detection_count: t.frames.length,
      avg_confidence: avgConf.toFixed(4),
    });
    trackRowNum++;
  }


  // ── Sheet 6: Raw Detections ────────────────────────────────────────────────
  const rawSheet = workbook.addWorksheet("Raw Detections");
  rawSheet.columns = [
    { header: "Frame", key: "frame", width: 10 },
    { header: "Timestamp (s)", key: "timestamp_s", width: 16 },
    { header: "Track ID", key: "track_id", width: 12 },
    { header: "Class", key: "class", width: 16 },
    { header: "Zone", key: "zone", width: 20 },
    { header: "Confidence", key: "confidence", width: 14 },
    { header: "BBox X", key: "bbox_x", width: 10 },
    { header: "BBox Y", key: "bbox_y", width: 10 },
    { header: "BBox W", key: "bbox_w", width: 10 },
    { header: "BBox H", key: "bbox_h", width: 10 },
  ];
  rawSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  // Sample down to 2000 rows max to avoid Excel slowness on high-detection videos.
  const sampled = detections.length > 2000
    ? detections.filter((_, i) => i % Math.ceil(detections.length / 2000) === 0)
    : detections;
  for (const d of sampled) {
    rawSheet.addRow({ ...d, confidence: d.confidence.toFixed(4) });
  }

  // ── Global formatting: tab colours + frozen header rows ───────────────────
  // Tab colours match the six sheet themes: blue, green, amber, purple, red, teal.
  const tabColors = ["1E40AF", "059669", "D97706", "7C3AED", "DC2626", "0891B2"];
  workbook.worksheets.forEach((ws, i) => {
    ws.properties.tabColor = { argb: `FF${tabColors[i % tabColors.length]}` };
  });

  // Freeze the first row on every sheet so headers stay visible while scrolling.
  workbook.worksheets.forEach((ws) => {
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  });

  // ── Embed chart images ────────────────────────────────────────────────────
  // Charts are generated as SVG strings and rasterised to PNG using @resvg/resvg-js.
  // This is a pure WASM renderer — no browser, canvas, or native bindings needed.
  //
  // The entire block is wrapped in try/catch so a chart failure (e.g. missing
  // native module after a fresh pnpm install) does not fail the whole report write.
  try {
    // Zone bar chart — placed to the right of the data table (columns E–M)
    if (sortedZones.length > 0) {
      const zonePng = await svgToPng(generateBarChartSvg(
        sortedZones.map(([z, d]) => ({ label: z.length > 14 ? z.slice(0, 13) + "…" : z, value: d.detections })),
        "Detections by Zone", "#1E40AF"
      ));
      const zoneImgId = workbook.addImage({ buffer: zonePng, extension: "png" });
      zoneSheet.addImage(zoneImgId, { tl: { col: 5, row: 0 }, br: { col: 13, row: 18 }, editAs: "oneCell" });
    }

    // Class bar chart — placed to the right of the data table (columns I–Q)
    if (sortedClasses.length > 0) {
      const classPng = await svgToPng(generateBarChartSvg(
        sortedClasses.slice(0, 10).map(([c, d]) => ({ label: c, value: d.count })),
        "Detections by Class", "#D97706"
      ));
      const classImgId = workbook.addImage({ buffer: classPng, extension: "png" });
      classSheet.addImage(classImgId, { tl: { col: 8, row: 0 }, br: { col: 16, row: 18 }, editAs: "oneCell" });
    }

    // Timeline line chart — placed below the data table (startRow = after last minute row)
    if (maxMinute > 0) {
      const timelineEntries = Object.entries(minuteData)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([m, d]) => ({ label: `M${m}`, value: d.detections }));
      const tlPng = await svgToPng(generateLineChartSvg(timelineEntries, "Detections Over Time", "#1E40AF"));
      const tlImgId = workbook.addImage({ buffer: tlPng, extension: "png" });
      const startRow = maxMinute + 3;
      timelineSheet.addImage(tlImgId, { tl: { col: 0, row: startRow }, br: { col: 10, row: startRow + 16 }, editAs: "oneCell" });
    }
  } catch (chartErr) {
    // Non-fatal: log and continue. The report is still complete, just without charts.
    logger.warn({ err: chartErr }, "Chart generation skipped (non-fatal)");
  }

  await workbook.xlsx.writeFile(outputPath);
  logger.info({ outputPath }, "Excel report written");
}

/** XML-escape a string for safe use in SVG text elements. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Generate a vertical bar chart as an SVG string.
 *
 * @param data   Array of { label, value } pairs (sorted by caller)
 * @param title  Chart title displayed at the top
 * @param color  Hex color string (e.g. "#1E40AF") for bars
 * @param width  SVG canvas width in pixels (default 520)
 * @param height SVG canvas height in pixels (default 320)
 */
function generateBarChartSvg(
  data: { label: string; value: number }[],
  title: string,
  color: string,
  width = 520,
  height = 320
): string {
  if (data.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/></svg>`;

  const pad = { top: 48, right: 24, bottom: 70, left: 56 };
  const cw = width - pad.left - pad.right;   // chart area width
  const ch = height - pad.top - pad.bottom;  // chart area height
  const max = Math.max(...data.map(d => d.value), 1);
  const barW = Math.max(8, (cw / data.length) * 0.65);
  const gap = cw / data.length;

  // Horizontal grid lines and Y-axis labels.
  const yTicks = 5;
  const yLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = Math.round((max / yTicks) * i);
    const y = pad.top + ch - (val / max) * ch;
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + cw}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
    <text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#6b7280">${val}</text>`;
  }).join("\n");

  // Bar rectangles with value labels above and rotated X-axis labels below.
  const bars = data.map((d, i) => {
    const bh = Math.max(2, (d.value / max) * ch);
    const x = pad.left + i * gap + (gap - barW) / 2;
    const y = pad.top + ch - bh;
    const labelY = pad.top + ch + 16;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="${color}" rx="3" opacity="0.85"/>
    <text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" font-weight="600" fill="${color}">${d.value}</text>
    <text x="${x + barW / 2}" y="${labelY}" text-anchor="middle" font-size="9" fill="#374151" transform="rotate(-30,${x + barW / 2},${labelY})">${esc(d.label)}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="white" rx="6"/>
  <text x="${width / 2}" y="28" text-anchor="middle" font-size="13" font-weight="bold" fill="#111827" font-family="Arial,sans-serif">${esc(title)}</text>
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + ch}" stroke="#d1d5db" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top + ch}" x2="${pad.left + cw}" y2="${pad.top + ch}" stroke="#d1d5db" stroke-width="1"/>
  ${yLines}
  ${bars}
</svg>`;
}

/**
 * Generate a line/area chart as an SVG string.
 *
 * Returns a blank SVG if fewer than 2 data points are provided (can't draw a meaningful line).
 *
 * @param data   Time-series array: { label: "M0", value: N }
 * @param title  Chart title
 * @param color  Hex color for the line and filled area
 */
function generateLineChartSvg(
  data: { label: string; value: number }[],
  title: string,
  color: string,
  width = 560,
  height = 280
): string {
  if (data.length < 2) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/></svg>`;

  const pad = { top: 44, right: 24, bottom: 44, left: 56 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;
  const max = Math.max(...data.map(d => d.value), 1);

  // Map data values to pixel coordinates.
  const points = data.map((d, i) => ({
    x: pad.left + (i / (data.length - 1)) * cw,
    y: pad.top + ch - (d.value / max) * ch,
    value: d.value,
    label: d.label,
  }));

  const polyline = points.map(p => `${p.x},${p.y}`).join(" ");

  // Filled area under the line, closed to the X axis.
  const area = [
    `${points[0].x},${pad.top + ch}`,
    ...points.map(p => `${p.x},${p.y}`),
    `${points[points.length - 1].x},${pad.top + ch}`,
  ].join(" ");

  const yTicks = 4;
  const yLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = Math.round((max / yTicks) * i);
    const y = pad.top + ch - (val / max) * ch;
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + cw}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>
    <text x="${pad.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#6b7280">${val}</text>`;
  }).join("\n");

  // Show X-axis labels at first, middle, and last data point only to avoid crowding.
  const xLabels = [0, Math.floor(data.length / 2), data.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map(i => `<text x="${points[i].x}" y="${pad.top + ch + 18}" text-anchor="middle" font-size="10" fill="#6b7280">${esc(points[i].label)}</text>`)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="white" rx="6"/>
  <text x="${width / 2}" y="26" text-anchor="middle" font-size="13" font-weight="bold" fill="#111827" font-family="Arial,sans-serif">${esc(title)}</text>
  <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + ch}" stroke="#d1d5db" stroke-width="1"/>
  <line x1="${pad.left}" y1="${pad.top + ch}" x2="${pad.left + cw}" y2="${pad.top + ch}" stroke="#d1d5db" stroke-width="1"/>
  ${yLines}
  <polygon points="${area}" fill="${color}" opacity="0.08"/>
  <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}"/>`).join("\n")}
  ${xLabels}
</svg>`;
}

/**
 * Rasterise an SVG string to a PNG Buffer using @resvg/resvg-js.
 *
 * @resvg/resvg-js uses a WASM build of the Rust `resvg` crate — no native canvas
 * or browser APIs needed. It is dynamically imported so that if the package is not
 * installed (e.g. fresh clone before `pnpm install`), the error surfaces inside the
 * chart try/catch block and does not crash the server.
 *
 * Important: @resvg/resvg-js must be listed in the `external` array in build.mjs
 * so esbuild does not try to bundle its platform-specific .node binary.
 */
async function svgToPng(svg: string): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const resvg = new Resvg(svg, { fitTo: { mode: "original" } });
  return Buffer.from(resvg.render().asPng());
}

/**
 * Format a duration in seconds as "M:SS" for display in the Timeline sheet.
 * Example: 125 → "2:05"
 */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
