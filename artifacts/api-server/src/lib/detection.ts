import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import { logger } from "./logger";

const CLASSES = ["person", "car", "truck", "bicycle", "motorcycle", "bus", "dog", "cat"];
const ZONES = ["Zone A", "Zone B", "Zone C", "Zone D"];

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

interface Track {
  track_id: number;
  class: string;
  zone: string;
  first_seen_s: number;
  last_seen_s: number;
  detection_count: number;
  avg_confidence: number;
}

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max));
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface VideoStats {
  fileSizeBytes: number;
  durationSeconds: number;
  totalDetections: number;
  totalTracks: number;
}

export async function runDetectionPipeline(
  videoPath: string,
  reportPath: string
): Promise<VideoStats> {
  const fileSizeBytes = fs.statSync(videoPath).size;

  const estimatedDuration = Math.max(10, fileSizeBytes / (500 * 1024));
  const fps = 25;
  const numFrames = Math.min(Math.floor(estimatedDuration * fps), 5000);

  logger.info({ videoPath, numFrames, estimatedDuration }, "Starting mock detection pipeline");

  const detections: Detection[] = [];
  const trackMap = new Map<number, { class: string; zone: string; frames: number[]; confidences: number[] }>();

  let nextTrackId = 1;
  const activeObjects: Map<number, { class: string; zone: string; deathFrame: number }> = new Map();

  for (let frame = 0; frame < numFrames; frame += 5) {
    const timestamp = frame / fps;

    if (Math.random() < 0.3 && activeObjects.size < 20) {
      const id = nextTrackId++;
      activeObjects.set(id, {
        class: pickRandom(CLASSES),
        zone: pickRandom(ZONES),
        deathFrame: frame + randomInt(25, 300),
      });
    }

    for (const [id, obj] of activeObjects.entries()) {
      if (frame > obj.deathFrame) {
        activeObjects.delete(id);
        continue;
      }

      const confidence = randomBetween(0.55, 0.99);
      const detection: Detection = {
        frame,
        timestamp_s: timestamp,
        track_id: id,
        class: obj.class,
        zone: obj.zone,
        confidence,
        bbox_x: randomInt(0, 1820),
        bbox_y: randomInt(0, 980),
        bbox_w: randomInt(30, 200),
        bbox_h: randomInt(30, 200),
      };
      detections.push(detection);

      if (!trackMap.has(id)) {
        trackMap.set(id, { class: obj.class, zone: obj.zone, frames: [], confidences: [] });
      }
      const t = trackMap.get(id)!;
      t.frames.push(frame);
      t.confidences.push(confidence);
    }
  }

  const tracks: Track[] = [];
  for (const [id, t] of trackMap.entries()) {
    const avgConf = t.confidences.reduce((a, b) => a + b, 0) / t.confidences.length;
    tracks.push({
      track_id: id,
      class: t.class,
      zone: t.zone,
      first_seen_s: t.frames[0] / fps,
      last_seen_s: t.frames[t.frames.length - 1] / fps,
      detection_count: t.frames.length,
      avg_confidence: avgConf,
    });
  }

  await generateExcelReport(videoPath, fileSizeBytes, estimatedDuration, detections, tracks, reportPath);

  return {
    fileSizeBytes,
    durationSeconds: estimatedDuration,
    totalDetections: detections.length,
    totalTracks: tracks.length,
  };
}

async function generateExcelReport(
  videoPath: string,
  fileSizeBytes: number,
  durationSeconds: number,
  detections: Detection[],
  tracks: Track[],
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
    { property: "Estimated Duration", value: `${durationSeconds.toFixed(1)}s` },
    { property: "Total Detections", value: detections.length },
    { property: "Total Unique Tracks", value: tracks.length },
    { property: "Analysis Date", value: new Date().toISOString() },
    { property: "Detection Model", value: "Mock YOLO v8 (placeholder)" },
  ]);

  const zoneSheet = workbook.addWorksheet("Zone Summary");
  const zoneCounts: Record<string, number> = {};
  for (const d of detections) {
    zoneCounts[d.zone] = (zoneCounts[d.zone] ?? 0) + 1;
  }
  zoneSheet.columns = [
    { header: "Zone", key: "zone", width: 20 },
    { header: "Detection Count", key: "count", width: 20 },
    { header: "Percentage", key: "pct", width: 20 },
  ];
  zoneSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  const totalDet = detections.length || 1;
  for (const [zone, count] of Object.entries(zoneCounts)) {
    zoneSheet.addRow({ zone, count, pct: `${((count / totalDet) * 100).toFixed(1)}%` });
  }


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
    { header: "Avg Confidence", key: "conf", width: 20 },
    { header: "Percentage", key: "pct", width: 20 },
  ];
  classSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  for (const [cls, data] of Object.entries(classCounts)) {
    classSheet.addRow({
      cls,
      count: data.count,
      conf: (data.totalConf / data.count).toFixed(3),
      pct: `${((data.count / totalDet) * 100).toFixed(1)}%`,
    });
  }

  const tracksSheet = workbook.addWorksheet("Tracks");
  tracksSheet.columns = [
    { header: "Track ID", key: "track_id", width: 12 },
    { header: "Class", key: "class", width: 16 },
    { header: "Zone", key: "zone", width: 16 },
    { header: "First Seen (s)", key: "first_seen_s", width: 16 },
    { header: "Last Seen (s)", key: "last_seen_s", width: 16 },
    { header: "Detection Count", key: "detection_count", width: 18 },
    { header: "Avg Confidence", key: "avg_confidence", width: 18 },
  ];
  tracksSheet.getRow(1).eachCell((cell) => { Object.assign(cell, headerStyle); });
  for (const t of tracks.slice(0, 500)) {
    tracksSheet.addRow({ ...t, avg_confidence: t.avg_confidence.toFixed(3) });
  }

  const rawSheet = workbook.addWorksheet("Raw Detections");
  rawSheet.columns = [
    { header: "Frame", key: "frame", width: 10 },
    { header: "Timestamp (s)", key: "timestamp_s", width: 16 },
    { header: "Track ID", key: "track_id", width: 12 },
    { header: "Class", key: "class", width: 16 },
    { header: "Zone", key: "zone", width: 16 },
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

  const tabColors = ["1E40AF", "059669", "D97706", "DC2626", "7C3AED"];
  workbook.worksheets.forEach((ws, i) => {
    ws.properties.tabColor = { argb: `FF${tabColors[i % tabColors.length]}` };
  });

  await workbook.xlsx.writeFile(outputPath);
  logger.info({ outputPath }, "Excel report generated");
}
