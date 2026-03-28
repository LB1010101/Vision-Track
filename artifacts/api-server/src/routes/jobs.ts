/**
 * routes/jobs.ts — VisionTrack Job API Handlers
 *
 * Registers all /api/* routes for the job lifecycle:
 *   GET    /jobs           — list all jobs
 *   POST   /upload         — upload a video and create a pending job
 *   POST   /process/:jobId — start the detection pipeline (non-blocking)
 *   GET    /status/:jobId  — poll a single job's status
 *   GET    /download/:jobId— download the generated Excel report
 *   GET    /video/:jobId   — stream the annotated video with range request support
 *   DELETE /jobs/:jobId    — delete job, video, report, and annotated video
 *
 * Processing model:
 *   POST /process responds immediately with 200 and fires the pipeline inside
 *   setImmediate() so the HTTP response is not held open. The DB row is updated
 *   to "complete" or "failed" once the pipeline finishes. The frontend polls
 *   GET /jobs every 2.5 seconds to detect completion.
 */

import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq } from "drizzle-orm";
import { db, jobsTable } from "@workspace/db";
import {
  ListJobsResponse,
  GetJobStatusResponse,
  ProcessJobParams,
  GetJobStatusParams,
  DownloadReportParams,
  DeleteJobParams,
} from "@workspace/api-zod";
import { runDetectionPipeline } from "../lib/detection";
import { logger } from "../lib/logger";

// ── Directory setup ──────────────────────────────────────────────────────────
// All directories are relative to the api-server package root (process.cwd()).
// They are created on startup if they don't exist.
const UPLOADS_DIR  = path.resolve(process.cwd(), "uploads");
const REPORTS_DIR  = path.resolve(process.cwd(), "reports");
const ANNOTATED_DIR = path.resolve(process.cwd(), "annotated");

for (const dir of [UPLOADS_DIR, REPORTS_DIR, ANNOTATED_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Upload configuration ─────────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm"]);

/** 2 GB max upload — sufficient for typical CCTV footage segments. */
const MAX_FILE_SIZE_BYTES = 2048 * 1024 * 1024;

/** Multer storage: write to uploads/ with a UUID-timestamp filename to avoid collisions. */
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: mp4, avi, mov, mkv, webm`));
    }
  },
});

const router: IRouter = Router();

// ── GET /jobs ─────────────────────────────────────────────────────────────────
// Returns the full jobs list ordered by created_at ascending.
// Validated against the ListJobsResponse Zod schema (generated from openapi.yaml).
router.get("/jobs", async (req, res): Promise<void> => {
  const jobs = await db.select().from(jobsTable).orderBy(jobsTable.createdAt);
  res.json(ListJobsResponse.parse(jobs));
});

// ── POST /upload ──────────────────────────────────────────────────────────────
// Multer writes the file to uploads/ then this handler inserts a pending DB row.
// Returns the new job object. The frontend immediately calls POST /process/:jobId next.
router.post("/upload", upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      filename: req.file.filename,
      originalName: req.file.originalname,
      status: "pending",
      fileSizeBytes: req.file.size,
    })
    .returning();

  req.log.info({ jobId: job.id, filename: job.filename }, "Job created");
  res.status(201).json(GetJobStatusResponse.parse(job));
});

// ── POST /process/:jobId ──────────────────────────────────────────────────────
// Sets the job to "processing" and responds immediately.
// The actual pipeline runs in setImmediate() — non-blocking so the HTTP response
// is sent before the potentially multi-minute processing begins.
//
// If the job is already processing (duplicate request), returns the current state.
router.post("/process/:jobId", async (req, res): Promise<void> => {
  const params = ProcessJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Idempotent: if already processing, return the current state without re-queuing.
  if (job.status === "processing") {
    res.json(GetJobStatusResponse.parse(job));
    return;
  }

  // Mark as processing in the DB before responding so the frontend sees the update
  // on its next poll, even if the pipeline hasn't started yet.
  const [updatedJob] = await db
    .update(jobsTable)
    .set({ status: "processing" })
    .where(eq(jobsTable.id, job.id))
    .returning();

  // Respond first, then start the pipeline in the next event loop tick.
  res.json(GetJobStatusResponse.parse(updatedJob));

  const videoPath = path.join(UPLOADS_DIR, job.filename);
  const reportPath = path.join(REPORTS_DIR, `report-${job.id}.xlsx`);
  const annotatedVideoPath = path.join(ANNOTATED_DIR, `annotated-${job.id}.mp4`);

  setImmediate(async () => {
    try {
      const stats = await runDetectionPipeline(videoPath, reportPath, annotatedVideoPath);
      // Prefer the path returned by the pipeline; fall back to checking the expected path
      // on disk in case detection.ts returned null due to a timing/existsSync issue.
      const savedAnnotatedPath =
        stats.annotatedVideoPath ||
        (fs.existsSync(annotatedVideoPath) ? annotatedVideoPath : null);
      await db
        .update(jobsTable)
        .set({
          status: "complete",
          durationSeconds: stats.durationSeconds,
          totalDetections: stats.totalDetections,
          totalTracks: stats.totalTracks,
          reportPath: reportPath,
          annotatedVideoPath: savedAnnotatedPath,
        })
        .where(eq(jobsTable.id, job.id));
      logger.info({ jobId: job.id }, "Processing complete");
    } catch (err) {
      logger.error({ err, jobId: job.id }, "Processing failed");
      await db
        .update(jobsTable)
        .set({ status: "failed", errorMessage: String(err) })
        .where(eq(jobsTable.id, job.id));
    }
  });
});

// ── GET /status/:jobId ────────────────────────────────────────────────────────
// Single-job status poll. The frontend uses the list endpoint for polling,
// but this can be used for targeted status checks.
router.get("/status/:jobId", async (req, res): Promise<void> => {
  const params = GetJobStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(GetJobStatusResponse.parse(job));
});

// ── GET /download/:jobId ──────────────────────────────────────────────────────
// Streams the Excel report to the browser as a file download.
// The download filename is derived from the original video filename for clarity.
router.get("/download/:jobId", async (req, res): Promise<void> => {
  const params = DownloadReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job || !job.reportPath) {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  if (!fs.existsSync(job.reportPath)) {
    res.status(404).json({ error: "Report file not found on disk" });
    return;
  }

  const downloadName = `visiontrack-report-${job.originalName.replace(/\.[^.]+$/, "")}.xlsx`;
  res.download(job.reportPath, downloadName, (err) => {
    if (err) {
      req.log.error({ err, jobId: job.id }, "Error sending report file");
    }
  });
});

// ── GET /video/:jobId ─────────────────────────────────────────────────────────
// Streams the H.264 annotated video with HTTP range request support.
//
// Range requests are required for the browser <video> element to support seeking.
// Without them, Safari and Chrome will request bytes=0- repeatedly and the video
// will refuse to seek. This handler implements RFC 7233 partial content responses.
//
// The annotatedVideoPath must be stored in the DB row (set after successful pipeline run).
router.get("/video/:jobId", async (req, res): Promise<void> => {
  const params = GetJobStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.jobId));
  if (!job || !job.annotatedVideoPath) {
    res.status(404).json({ error: "Annotated video not available" });
    return;
  }

  if (!fs.existsSync(job.annotatedVideoPath)) {
    res.status(404).json({ error: "Annotated video file not found on disk" });
    return;
  }

  const stat = fs.statSync(job.annotatedVideoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  // inline disposition: browser plays it in the modal rather than forcing download.
  res.setHeader("Content-Disposition", `inline; filename="annotated-${job.originalName}"`);

  if (range) {
    // Partial content (206) — browser is seeking or streaming mid-file.
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);
    res.status(206);

    const stream = fs.createReadStream(job.annotatedVideoPath, { start, end });
    stream.pipe(res);
  } else {
    // Full content (200) — initial load or non-range-aware client.
    res.setHeader("Content-Length", fileSize);
    res.status(200);
    fs.createReadStream(job.annotatedVideoPath).pipe(res);
  }
});

// ── DELETE /jobs/:jobId ───────────────────────────────────────────────────────
// Deletes the DB row and all associated files from disk.
// Files that don't exist (e.g. failed job with no report) are skipped gracefully.
router.delete("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Delete the DB row first and get its data for file cleanup.
  const [job] = await db
    .delete(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Clean up all files associated with the job.
  const videoPath = path.join(UPLOADS_DIR, job.filename);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  if (job.reportPath && fs.existsSync(job.reportPath)) fs.unlinkSync(job.reportPath);
  if (job.annotatedVideoPath && fs.existsSync(job.annotatedVideoPath)) fs.unlinkSync(job.annotatedVideoPath);

  req.log.info({ jobId: job.id }, "Job deleted");
  res.sendStatus(204);
});

export default router;
