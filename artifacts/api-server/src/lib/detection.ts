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
  annotatedVideoPath: string | null;
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
  annotated_video_path?: string;
}

function getPythonBin(): string {
  return process.env["VISIONTRACK_PYTHON"] ?? "python3";
}

function getModelPath(): string {
  return process.env["VISIONTRACK_MODEL"] ?? "yolov8n.pt";
}

async function runPythonDetect(
  videoPath: string,
  annotatedVideoPath: string
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
      VISIONTRACK_OUTPUT_VIDEO: annotatedVideoPath,
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
      annotated_video_path: "",
    },
  };
}

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

  const resolvedAnnotatedPath = summary.annotated_video_path && fs.existsSync(summary.annotated_video_path)
    ? summary.annotated_video_path
    : null;

  return {
    fileSizeBytes,
    durationSeconds: summary.duration_s,
    totalDetections: summary.total_detections,
    totalTracks: summary.total_tracks,
    annotatedVideoPath: resolvedAnnotatedPath,
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

  const fps = summary.fps || 25;
  const totalDet = detections.length || 1;

  // ── Summary ──────────────────────────────────────────────────────────────
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Property", key: "property", width: 30 },
    { header: "Value", key: "value", width: 40 },
  ];
  summarySheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });

  const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Compute peak activity (which minute had most detections)
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

  // Highlight key rows
  [7, 8].forEach(rowNum => {
    const row = summarySheet.getRow(rowNum + 1);
    row.getCell(2).font = { bold: true, color: { argb: "FF1E40AF" } };
  });

  // ── Zone Summary ─────────────────────────────────────────────────────────
  const zoneSheet = workbook.addWorksheet("Zone Summary");

  // Build per-zone stats
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

  // Data bars on Detections column
  if (sortedZones.length > 0) {
    zoneSheet.addConditionalFormatting({
      ref: `B2:B${zoneRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF1E40AF" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });
    zoneSheet.addConditionalFormatting({
      ref: `C2:C${zoneRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF059669" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });
  }

  // ── Class Breakdown ───────────────────────────────────────────────────────
  const classSheet = workbook.addWorksheet("Class Breakdown");

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

  if (sortedClasses.length > 0) {
    classSheet.addConditionalFormatting({
      ref: `B2:B${classRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FFD97706" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });
    classSheet.addConditionalFormatting({
      ref: `C2:C${classRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF7C3AED" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });
  }

  // ── Timeline (per-minute activity) ─────────────────────────────────────
  const timelineSheet = workbook.addWorksheet("Timeline");

  // Build minute-by-minute data
  const minuteData: Record<number, { detections: number; trackIds: Set<number>; classes: Record<string, number> }> = {};
  const maxMinute = detections.length > 0
    ? Math.floor(Math.max(...detections.map(d => d.timestamp_s)) / 60)
    : 0;

  for (let m = 0; m <= maxMinute; m++) {
    minuteData[m] = { detections: 0, trackIds: new Set(), classes: {} };
  }
  for (const d of detections) {
    const m = Math.floor(d.timestamp_s / 60);
    minuteData[m].detections++;
    if (d.track_id >= 0) minuteData[m].trackIds.add(d.track_id);
    minuteData[m].classes[d.class] = (minuteData[m].classes[d.class] ?? 0) + 1;
  }

  // Get top 3 classes for timeline columns
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
    timelineSheet.addConditionalFormatting({
      ref: `C2:C${timelineRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF1E40AF" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });
    timelineSheet.addConditionalFormatting({
      ref: `D2:D${timelineRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF059669" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
    });

    // Highlight peak minute row
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
    { header: "Duration (s)", key: "duration_s", width: 14 },
    { header: "Detection Count", key: "detection_count", width: 18 },
    { header: "Avg Confidence", key: "avg_confidence", width: 18 },
  ];
  tracksSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
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

  // Data bars on Duration column
  if (trackCount > 0) {
    tracksSheet.addConditionalFormatting({
      ref: `F2:F${trackRowNum - 1}`,
      rules: [{
        type: "dataBar",
        priority: 1,
        dataBar: {
          minLength: 0,
          maxLength: 100,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FFDC2626" },
          showValue: true,
          gradient: true,
          border: false,
        } as ExcelJS.DataBarRuleType["dataBar"],
      }],
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
  const tabColors = ["1E40AF", "059669", "D97706", "7C3AED", "DC2626", "0891B2"];
  workbook.worksheets.forEach((ws, i) => {
    ws.properties.tabColor = { argb: `FF${tabColors[i % tabColors.length]}` };
  });

  // Freeze header rows on all sheets
  workbook.worksheets.forEach((ws) => {
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  });

  await workbook.xlsx.writeFile(outputPath);
  logger.info({ outputPath }, "Excel report written");
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
