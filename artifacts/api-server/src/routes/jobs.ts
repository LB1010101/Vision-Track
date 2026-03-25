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

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const REPORTS_DIR = path.resolve(process.cwd(), "reports");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm"]);
const MAX_FILE_SIZE_BYTES = 2048 * 1024 * 1024;

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

router.get("/jobs", async (req, res): Promise<void> => {
  const jobs = await db.select().from(jobsTable).orderBy(jobsTable.createdAt);
  res.json(ListJobsResponse.parse(jobs));
});

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

  if (job.status === "processing") {
    res.json(GetJobStatusResponse.parse(job));
    return;
  }

  const [updatedJob] = await db
    .update(jobsTable)
    .set({ status: "processing" })
    .where(eq(jobsTable.id, job.id))
    .returning();

  res.json(GetJobStatusResponse.parse(updatedJob));

  const videoPath = path.join(UPLOADS_DIR, job.filename);
  const reportPath = path.join(REPORTS_DIR, `report-${job.id}.xlsx`);

  setImmediate(async () => {
    try {
      const stats = await runDetectionPipeline(videoPath, reportPath);
      await db
        .update(jobsTable)
        .set({
          status: "complete",
          durationSeconds: stats.durationSeconds,
          totalDetections: stats.totalDetections,
          totalTracks: stats.totalTracks,
          reportPath: reportPath,
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

router.delete("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = DeleteJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .delete(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const videoPath = path.join(UPLOADS_DIR, job.filename);
  if (fs.existsSync(videoPath)) {
    fs.unlinkSync(videoPath);
  }
  if (job.reportPath && fs.existsSync(job.reportPath)) {
    fs.unlinkSync(job.reportPath);
  }

  req.log.info({ jobId: job.id }, "Job deleted");
  res.sendStatus(204);
});

export default router;
