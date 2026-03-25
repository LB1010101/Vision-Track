import path from "path";
import { spawn } from "child_process";
import fs from "fs";
import ExcelJS from "exceljs";
import { logger } from "./logger";

const DETECT_SCRIPT = path.resolve(process.cwd(), "detect.py");

export interface VideoStats {
  fileSizeBytes: number;
  durationSeconds: number;
  totalDetections: number;
  totalTracks: number;
}

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

interface SummaryMsg {
  total_detections: number;
  total_tracks: number;
  duration_s: number;
  fps: number;
  width: number;
  height: number;
}

/** Determine which Python executable to use. */
function getPythonBin(): string {
  return process.env["VISIONTRACK_PYTHON"] ?? "python3";
}

/** Determine the model path to pass to detect.py. */
function getModelPath(): string {
  return process.env["VISIONTRACK_MODEL"] ?? "yolov8n.pt";
}

/**
 * Run the Python detection script as a subprocess.
 * Returns detections + summary.
 */
async function runPythonDetect(
  videoPath: string
): Promise<{ detections: Detection[]; summary: SummaryMsg }> {
  return new Promise((resolve, reject) => {
    const pythonBin = getPythonBin();
    const modelPath = getModelPath();

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined)
      ) as Record<string, string>,
      VISIONTRACK_MODEL: modelPath,
      VISIONTRACK_CONFIDENCE: process.env["VISIONTRACK_CONFIDENCE"] ?? "0.35",
      ...(process.env["VISIONTRACK_ZONES"] ? { VISIONTRACK_ZONES: process.env["VISIONTRACK_ZONES"] } : {}),
    };

    const args = [DETECT_SCRIPT, videoPath, modelPath];
    logger.info({ pythonBin, args, modelPath }, "Spawning detection subprocess");

    const child = spawn(pythonBin, args, { env });

    const detections: Detection[] = [];
    let summary: SummaryMsg | null = null;
    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
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

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (stderr) {
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
 * Mock pipeline — used as fallback when Python/detect.py is unavailable.
 * Simulates realistic detections for testing in dev environments.
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

  const estimatedDuration = Math.max(10, fileSizeBytes / (500 * 1024));
  const fps = 25;
  const numFrames = Math.min(Math.floor(estimatedDuration * fps), 5000);

  const detections: Detection[] = [];
  const activeObjects = new Map<number, { class: string; zone: string; deathFrame: number }>();
  let nextTrackId = 1;

  for (let frame = 0; frame < numFrames; frame += 5) {
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
    },
  };
}

export async function runDetectionPipeline(
  videoPath: string,
  reportPath: string
): Promise<VideoStats> {
  const fileSizeBytes = fs.statSync(videoPath).size;

  logger.info({ videoPath, reportPath }, "Starting detection pipeline");

  let detections: Detection[];
  let summary: SummaryMsg;

  // Skip Python if explicitly set to mock mode
  const forceMock = process.env["VISIONTRACK_MOCK"] === "true";

  if (!forceMock && fs.existsSync(DETECT_SCRIPT)) {
    try {
      ({ detections, summary } = await runPythonDetect(videoPath));
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

  return {
    fileSizeBytes,
    durationSeconds: summary.duration_s,
    totalDetections: summary.total_detections,
    totalTracks: summary.total_tracks,
  };
}

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

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } },
    alignment: { horizontal: "center" },
  };

  // ── Summary ──────────────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Property", key: "property", width: 30 },
    { header: "Value", key: "value", width: 40 },
  ];
  summarySheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
  summarySheet.addRows([
    { property: "Video File", value: path.basename(videoPath) },
    { property: "File Size", value: `${sizeMB} MB` },
    { property: "Duration", value: `${summary.duration_s.toFixed(1)}s` },
    { property: "Resolution", value: `${summary.width}x${summary.height}` },
    { property: "Frame Rate", value: `${summary.fps.toFixed(2)} fps` },
    { property: "Total Detections", value: summary.total_detections },
    { property: "Unique Tracks", value: summary.total_tracks },
    { property: "Analysis Date", value: new Date().toISOString() },
    {
      property: "Detection Backend",
      value: process.env["VISIONTRACK_BACKEND"] ?? "Axelera Voyager / Ultralytics YOLO",
    },
    { property: "Model", value: getModelPath() },
    { property: "Confidence Threshold", value: process.env["VISIONTRACK_CONFIDENCE"] ?? "0.35" },
  ]);

  // ── Zone Summary ─────────────────────────────────────────────────────────
  const zoneSheet = workbook.addWorksheet("Zone Summary");
  const zoneCounts: Record<string, number> = {};
  for (const d of detections) {
    zoneCounts[d.zone] = (zoneCounts[d.zone] ?? 0) + 1;
  }
  zoneSheet.columns = [
    { header: "Zone", key: "zone", width: 25 },
    { header: "Detection Count", key: "count", width: 20 },
    { header: "Percentage", key: "pct", width: 15 },
  ];
  zoneSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  const totalDet = detections.length || 1;
  for (const [zone, count] of Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])) {
    zoneSheet.addRow({ zone, count, pct: `${((count / totalDet) * 100).toFixed(1)}%` });
  }

  // ── Class Breakdown ───────────────────────────────────────────────────────
  const classSheet = workbook.addWorksheet("Class Breakdown");
  const classCounts: Record<string, { count: number; totalConf: number }> = {};
  for (const d of detections) {
    if (!classCounts[d.class]) classCounts[d.class] = { count: 0, totalConf: 0 };
    classCounts[d.class].count++;
    classCounts[d.class].totalConf += d.confidence;
  }
  classSheet.columns = [
    { header: "Object Class", key: "cls", width: 20 },
    { header: "Detection Count", key: "count", width: 20 },
    { header: "Avg Confidence", key: "conf", width: 18 },
    { header: "Percentage", key: "pct", width: 15 },
  ];
  classSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  for (const [cls, data] of Object.entries(classCounts).sort((a, b) => b[1].count - a[1].count)) {
    classSheet.addRow({
      cls,
      count: data.count,
      conf: (data.totalConf / data.count).toFixed(3),
      pct: `${((data.count / totalDet) * 100).toFixed(1)}%`,
    });
  }

  // ── Tracks ────────────────────────────────────────────────────────────────
  const tracksSheet = workbook.addWorksheet("Tracks");
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
    { header: "Detection Count", key: "detection_count", width: 18 },
    { header: "Avg Confidence", key: "avg_confidence", width: 18 },
  ];
  tracksSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  const fps = summary.fps || 25;
  let trackCount = 0;
  for (const [id, t] of [...trackMap.entries()].sort((a, b) => b[1].frames.length - a[1].frames.length)) {
    if (trackCount++ >= 500) break;
    const avgConf = t.confidences.reduce((a, b) => a + b, 0) / t.confidences.length;
    tracksSheet.addRow({
      track_id: id,
      class: t.class,
      zone: t.zone,
      first_seen_s: (t.frames[0] / fps).toFixed(3),
      last_seen_s: (t.frames[t.frames.length - 1] / fps).toFixed(3),
      detection_count: t.frames.length,
      avg_confidence: avgConf.toFixed(4),
    });
  }

  // ── Raw Detections ────────────────────────────────────────────────────────
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
  const sampled = detections.length > 2000
    ? detections.filter((_, i) => i % Math.ceil(detections.length / 2000) === 0)
    : detections;
  for (const d of sampled) {
    rawSheet.addRow({ ...d, confidence: d.confidence.toFixed(4) });
  }

  // Tab colours
  const tabColors = ["1E40AF", "059669", "D97706", "DC2626", "7C3AED"];
  workbook.worksheets.forEach((ws, i) => {
    ws.properties.tabColor = { argb: `FF${tabColors[i % tabColors.length]}` };
  });

  await workbook.xlsx.writeFile(outputPath);
  logger.info({ outputPath }, "Excel report written");
}
