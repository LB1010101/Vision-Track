/**
 * schema/jobs.ts — Drizzle ORM schema for the VisionTrack jobs table.
 *
 * Single table: `jobs`
 * Tracks the full lifecycle of a video analysis job from upload through completion.
 *
 * Status lifecycle:
 *   pending → processing → complete
 *                        ↘ failed
 *
 * Managed via Drizzle ORM — no raw SQL anywhere in the codebase.
 * To apply schema changes: DATABASE_URL=... pnpm --filter @workspace/db run push
 */

import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobsTable = pgTable("jobs", {
  /** Auto-incrementing primary key. Used as the jobId in all API routes. */
  id: serial("id").primaryKey(),

  /** Unique filename on disk (UUID-timestamped, e.g. "1700000000-abc123.mp4"). */
  filename: text("filename").notNull(),

  /** Original filename as uploaded by the user — shown in reports and download names. */
  originalName: text("original_name").notNull(),

  /**
   * Job status. Transitions:
   *   "pending"    — uploaded, waiting for POST /process
   *   "processing" — detection pipeline running (setImmediate in jobs.ts)
   *   "complete"   — Excel report and annotated video written successfully
   *   "failed"     — pipeline threw; see errorMessage for details
   */
  status: text("status").notNull().default("pending"),

  /** Size of the uploaded video file in bytes. */
  fileSizeBytes: integer("file_size_bytes"),

  /** Video duration in seconds from ffprobe/OpenCV (set after processing). */
  durationSeconds: real("duration_seconds"),

  /** Total detection events across all frames (frame-level count, not unique objects). */
  totalDetections: integer("total_detections"),

  /** Number of unique tracked objects (distinct track_id values from ByteTrack). */
  totalTracks: integer("total_tracks"),

  /** Error message if status = "failed". Stored as the string form of the thrown error. */
  errorMessage: text("error_message"),

  /** Absolute path to the generated .xlsx file in the api-server/reports/ directory. */
  reportPath: text("report_path"),

  /**
   * Absolute path to the H.264 annotated MP4 in api-server/annotated/.
   * Null if the Python pipeline was not used (mock mode) or FFmpeg failed.
   * Set by detect.py → summary.annotated_video_path → detection.ts → DB update.
   */
  annotatedVideoPath: text("annotated_video_path"),

  /** Job creation timestamp (UTC with timezone). */
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  /**
   * Last-updated timestamp (UTC with timezone).
   * Automatically set to NOW() on every Drizzle .update() call via $onUpdate.
   */
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/** Zod schema for inserting a new job (excludes id, createdAt, updatedAt). */
export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertJob = z.infer<typeof insertJobSchema>;

/** TypeScript type inferred from the full table select (all columns). */
export type Job = typeof jobsTable.$inferSelect;
