# VisionTrack — Handover Document

**Platform:** Lenovo P360 Ultra · Ubuntu · Axelera AI M.2 Card  
**Date:** March 2026  
**Purpose:** Local CCTV video analytics — upload footage, run AI object detection, download Excel reports.

---

## Table of Contents

1. [What the App Does](#1-what-the-app-does)
2. [System Architecture](#2-system-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Database Schema](#4-database-schema)
5. [API Reference](#5-api-reference)
6. [Detection Pipeline](#6-detection-pipeline)
7. [Excel Report Format](#7-excel-report-format)
8. [Environment Variables](#8-environment-variables)
9. [Running Locally on the P360](#9-running-locally-on-the-p360)
10. [One-time Setup Checklist](#10-one-time-setup-checklist)
11. [Enabling Real AI Detection](#11-enabling-real-ai-detection)
12. [Enabling Axelera Hardware Acceleration](#12-enabling-axelera-hardware-acceleration)
13. [Troubleshooting](#13-troubleshooting)
14. [Code Reference](#14-code-reference)

---

## 1. What the App Does

VisionTrack is a self-hosted web application for analysing CCTV footage using AI:

1. User uploads a video file (`.mp4`, `.avi`, `.mov`, `.mkv`, `.webm`) via a browser.
2. The server runs object detection and tracking on every frame of the video.
3. A multi-sheet Excel report is generated containing detections, tracks, zone breakdowns, and class statistics.
4. User downloads the `.xlsx` report directly from the browser.

No internet connection is required once set up. Everything runs on the P360.

---

## 2. System Architecture

```
Browser (localhost:3000)
        │
        │  HTTP  /api/*  proxied by Vite dev server
        ▼
API Server (localhost:8080)   ←── Express + Node.js
        │
        ├── PostgreSQL database  (jobs table — status tracking)
        │
        ├── uploads/             (raw video files saved here)
        ├── reports/             (generated .xlsx files saved here)
        │
        └── detect.py  ◄── Python subprocess (spawned per job)
                │
                ├── Axelera Voyager SDK  (if hardware card present)
                └── Ultralytics YOLO    (CPU/GPU fallback)
```

- The **frontend** (React + Vite) polls `/api/jobs` every 2.5 seconds while any job is processing.
- The **API server** handles uploads, spawns the Python detection script, writes the database, and serves report downloads.
- The **Python script** streams results back to Node via `stdout` as newline-delimited JSON (NDJSON).
- If Python is unavailable, the API server falls back to a **mock simulation** (useful for testing without a GPU).

---

## 3. Repository Structure

```
Vision-Track/
├── artifacts/
│   ├── api-server/                  ← Express API (Node.js)
│   │   ├── src/
│   │   │   ├── index.ts             ← Server entry point
│   │   │   ├── app.ts               ← Express app setup, middleware
│   │   │   ├── routes/
│   │   │   │   ├── index.ts         ← Route registration
│   │   │   │   ├── jobs.ts          ← Upload, process, status, download, delete
│   │   │   │   └── health.ts        ← GET /api/healthz
│   │   │   └── lib/
│   │   │       ├── detection.ts     ← Python subprocess + mock + Excel report
│   │   │       └── logger.ts        ← Pino logger setup
│   │   ├── detect.py                ← Python detection script (Axelera / YOLO)
│   │   ├── requirements.txt         ← Python dependencies
│   │   ├── build.mjs                ← ESBuild config
│   │   ├── uploads/                 ← Video files (created at runtime)
│   │   └── reports/                 ← Excel reports (created at runtime)
│   │
│   └── visiontrack/                 ← React frontend (Vite)
│       └── src/
│           ├── pages/
│           │   └── Dashboard.tsx    ← Main page
│           ├── components/
│           │   ├── Layout.tsx       ← Shell with nav/header
│           │   ├── UploadZone.tsx   ← Drag-and-drop upload area
│           │   ├── StatsBar.tsx     ← Summary counters (jobs, detections, tracks)
│           │   ├── JobsTable.tsx    ← Table of all jobs with status + actions
│           │   └── StatusBadge.tsx  ← Colour-coded status pill
│           └── hooks/
│               └── use-jobs.ts      ← React Query hooks (list, upload, delete, download)
│
├── lib/
│   ├── db/                          ← Drizzle ORM + PostgreSQL
│   │   └── src/schema/jobs.ts       ← jobs table schema
│   └── api-spec/
│       └── openapi.yaml             ← OpenAPI spec (source of truth for types)
│
└── pnpm-workspace.yaml
```

---

## 4. Database Schema

Single table: **`jobs`**

| Column             | Type        | Description                                     |
|--------------------|-------------|-------------------------------------------------|
| `id`               | serial PK   | Auto-increment job ID                           |
| `filename`         | text        | Unique filename on disk (timestamped)           |
| `original_name`    | text        | Original filename as uploaded by user           |
| `status`           | text        | `pending` → `processing` → `complete` / `failed` |
| `file_size_bytes`  | integer     | Size of the uploaded video                      |
| `duration_seconds` | real        | Video duration from ffprobe/OpenCV              |
| `total_detections` | integer     | Total detection events across all frames        |
| `total_tracks`     | integer     | Number of unique tracked objects                |
| `error_message`    | text        | Error detail if `status = failed`               |
| `report_path`      | text        | Absolute path to the generated `.xlsx` file     |
| `created_at`       | timestamptz | Job creation time                               |
| `updated_at`       | timestamptz | Last update time (auto-updated)                 |

---

## 5. API Reference

Base URL: `http://localhost:8080`

| Method   | Path                    | Description                                          |
|----------|-------------------------|------------------------------------------------------|
| GET      | `/api/healthz`          | Health check — returns `{ status: "ok" }`            |
| GET      | `/api/jobs`             | List all jobs (array, ordered by `created_at`)       |
| POST     | `/api/upload`           | Upload video — `multipart/form-data` field `file`    |
| POST     | `/api/process/:jobId`   | Start processing an uploaded job                     |
| GET      | `/api/status/:jobId`    | Get a single job's current status                    |
| GET      | `/api/download/:jobId`  | Download the Excel report (triggers file download)   |
| DELETE   | `/api/jobs/:jobId`      | Delete job, video file, and report from disk         |

**Upload flow:**  
`POST /api/upload` → returns job object with `status: pending` → immediately call `POST /api/process/:jobId` → poll `GET /api/jobs` until `status: complete`.

**Supported video formats:** `.mp4` `.avi` `.mov` `.mkv` `.webm`  
**Max file size:** 2 GB

---

## 6. Detection Pipeline

### Node.js side (`artifacts/api-server/src/lib/detection.ts`)

1. Checks if `VISIONTRACK_MOCK=true` is set — if so, runs mock simulation directly.
2. Checks if `detect.py` exists on disk.
3. Spawns `detect.py` as a Python subprocess, passing the video path and model path.
4. Reads NDJSON from `stdout` line by line:
   - `{"type":"detection", ...}` → stored in memory
   - `{"type":"progress", ...}` → logged
   - `{"type":"summary", ...}` → stored as final stats
   - `{"type":"log", ...}` → forwarded to server log
   - `{"type":"error", ...}` → logged as error
5. If Python is not found or exits non-zero → falls back to mock pipeline.
6. Calls `generateExcelReport()` with all collected detections.

### Python side (`artifacts/api-server/detect.py`)

Tries inference backends in order:

**1. Axelera Voyager SDK** (`import axelera.runtime`)  
Uses the compiled `.axm` model on the Axelera M.2 AI card. Returns hardware-accelerated bounding boxes with track IDs.

**2. Ultralytics YOLO** (fallback)  
Uses `model.track()` with ByteTrack for multi-object tracking. Automatically downloads `yolov8n.pt` (~6 MB) on first run.

**Video metadata** is read via `ffprobe` first, then OpenCV, then estimated from file size.

**Zone classification** uses a ray-casting point-in-polygon algorithm. If no zones are configured, defaults to 4 quadrants (NW, NE, SW, SE).

---

## 7. Excel Report Format

Each report is a `.xlsx` workbook with 5 colour-coded sheets:

| Sheet              | Contents                                                                 |
|--------------------|--------------------------------------------------------------------------|
| **Summary**        | Video filename, size, duration, resolution, FPS, total detections/tracks, model used, confidence threshold |
| **Zone Summary**   | Detection count and percentage per zone, sorted by frequency            |
| **Class Breakdown**| Detection count, average confidence, and percentage per object class    |
| **Tracks**         | Per-track: class, zone, first/last seen (seconds), detection count, avg confidence |
| **Raw Detections** | Frame number, timestamp, track ID, class, zone, confidence, bounding box (x,y,w,h) — sampled to 2000 rows max |

---

## 8. Environment Variables

### API Server

| Variable                | Default           | Description                                              |
|-------------------------|-------------------|----------------------------------------------------------|
| `PORT`                  | **required**      | Port the API server listens on (use `8080`)             |
| `DATABASE_URL`          | **required**      | PostgreSQL connection string                             |
| `VISIONTRACK_PYTHON`    | `python3`         | Path to Python executable with ultralytics installed     |
| `VISIONTRACK_MODEL`     | `yolov8n.pt`      | YOLO model file (or `.axm` for Axelera)                 |
| `VISIONTRACK_CONFIDENCE`| `0.35`            | Minimum detection confidence (0.0–1.0)                  |
| `VISIONTRACK_ZONES`     | *(none)*          | JSON array of named polygon zones (see below)           |
| `VISIONTRACK_MOCK`      | `false`           | Set to `true` to skip Python and use simulated data     |

### Frontend

| Variable    | Default      | Description                                 |
|-------------|--------------|---------------------------------------------|
| `PORT`      | **required** | Port Vite serves on (use `3000`)            |
| `BASE_PATH` | **required** | URL base path (use `/` for local)           |

### Zone format example

```bash
VISIONTRACK_ZONES='[{"name":"Entrance","polygon":[[0,0],[960,0],[960,1080],[0,1080]]},{"name":"Car Park","polygon":[[960,0],[1920,0],[1920,1080],[960,1080]]}]'
```

---

## 9. Running Locally on the P360

You need **two terminals open simultaneously**.

### Terminal 1 — API Server

```bash
cd ~/Downloads/Vision-Track/Vision-Track

PORT=8080 \
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
VISIONTRACK_PYTHON=/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/.venv/bin/python3 \
pnpm --filter @workspace/api-server run dev
```

Wait for: `Server listening port: 8080`

### Terminal 2 — Frontend

```bash
cd ~/Downloads/Vision-Track/Vision-Track

PORT=3000 BASE_PATH=/ pnpm --filter @workspace/visiontrack run dev
```

Wait for: `VITE ready`

### Open in browser

```
http://localhost:3000
```

---

## 10. One-time Setup Checklist

Run these once after first downloading the project or after upgrading Node.

```bash
# 1. Node.js 22 (required — Vite needs v20+)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should show v22.x.x

# 2. pnpm
sudo npm install -g pnpm

# 3. Install all project dependencies
cd ~/Downloads/Vision-Track/Vision-Track
pnpm install

# 4. PostgreSQL
sudo apt install -y postgresql
sudo systemctl start postgresql
sudo systemctl enable postgresql

# 5. Create database
sudo -u postgres psql -c "CREATE USER visiontrack WITH PASSWORD 'visiontrack';"
sudo -u postgres psql -c "CREATE DATABASE visiontrack OWNER visiontrack;"

# 6. Create database tables
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
  pnpm --filter @workspace/db run push

# 7. ffmpeg (for video metadata)
sudo apt install -y ffmpeg

# 8. Python venv + YOLO
cd ~/Downloads/Vision-Track/Vision-Track/artifacts/api-server
python3 -m venv .venv
.venv/bin/pip install ultralytics opencv-python numpy
```

---

## 11. Enabling Real AI Detection

Once the Python venv is set up (step 8 above), pass `VISIONTRACK_PYTHON` when starting the API server:

```bash
VISIONTRACK_PYTHON=/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/.venv/bin/python3
```

On first use, `yolov8n.pt` (~6 MB) is downloaded automatically from Ultralytics.

To use a larger, more accurate model:

```bash
VISIONTRACK_MODEL=yolov8s.pt    # small — good balance
VISIONTRACK_MODEL=yolov8m.pt    # medium — better accuracy
VISIONTRACK_MODEL=yolov8l.pt    # large — high accuracy, slower
```

To raise or lower detection sensitivity:

```bash
VISIONTRACK_CONFIDENCE=0.5   # stricter (fewer false positives)
VISIONTRACK_CONFIDENCE=0.25  # looser (catches more, may include noise)
```

---

## 12. Enabling Axelera Hardware Acceleration

The P360 has an Axelera AI M.2 card. When the Axelera Voyager SDK is installed, `detect.py` will use it automatically — no code changes needed.

1. Install the Axelera Voyager SDK following Axelera's official documentation.
2. Compile your YOLO model to the Axelera `.axm` format using the Axelera Model Zoo tools.
3. Start the API server with the compiled model:

```bash
VISIONTRACK_MODEL=/path/to/your-model.axm \
VISIONTRACK_PYTHON=... \
PORT=8080 DATABASE_URL=... pnpm --filter @workspace/api-server run dev
```

The script (`detect.py`) tries `import axelera.runtime` first. If it succeeds, the hardware card is used. If not, it falls back to Ultralytics YOLO automatically.

---

## 13. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Command 'pnpm' not found` | pnpm not installed | `sudo npm install -g pnpm` |
| `Vite requires Node.js 20+` | Node.js 18 still active | Re-run the NodeSource setup for v22 |
| `Cannot find native binding` | node_modules built for wrong Node version | `rm -rf node_modules && pnpm install` |
| `DATABASE_URL must be set` | Env var missing | Add `DATABASE_URL=postgresql://...` to the start command |
| `Failed query: relation "jobs" does not exist` | Tables not created | Run `pnpm --filter @workspace/db run push` |
| `connect ECONNREFUSED 127.0.0.1:8080` | API server not running | Start Terminal 1 first, wait for `Server listening` |
| `Upload failed: Internal Server Error` | API server error | Check Terminal 1 output for the actual error |
| Report contains mock/simulated data | Python not found or VISIONTRACK_PYTHON not set | Set `VISIONTRACK_PYTHON` to your venv's python3 path |
| Port 3000 already in use | Old Vite process still running | Vite picks next port automatically (3001, 3002…) — use whatever it says |
| `jobs.filter is not a function` | API server not reachable | Check ECONNREFUSED — start API server first |

---

## 14. Code Reference

### `detect.py` — Python Detection Script

**Entry point:** `main()`

| Function | Purpose |
|----------|---------|
| `get_video_metadata(path)` | Returns `(width, height, duration_s, fps)` — tries ffprobe, then OpenCV, then estimates from file size |
| `parse_zones(json_str)` | Parses `VISIONTRACK_ZONES` env var into a list of `{name, polygon}` dicts |
| `classify_zone(cx, cy, zones, w, h)` | Returns the zone name for a point using ray-casting; defaults to 4 quadrants if no zones defined |
| `point_in_polygon(x, y, polygon)` | Ray-casting algorithm — returns True if point is inside polygon |
| `run_with_axelera(...)` | Attempts Axelera Voyager SDK inference; returns `None` if SDK not installed (triggers YOLO fallback) |
| `run_with_ultralytics(...)` | Runs YOLOv8 + ByteTrack on the full video; yields one detection dict per detected object per frame |
| `emit(obj)` | Writes a JSON object to `stdout` immediately (flush=True) |

**Output format (NDJSON on stdout):**
```json
{"type":"log",       "message":"Processing: myvideo.mp4"}
{"type":"log",       "message":"Video: 1920x1080 @ 25.0fps, 120.0s"}
{"type":"detection", "frame":0, "timestamp_s":0.0, "track_id":1, "class":"person", "zone":"Zone A (NW)", "confidence":0.87, "bbox_x":120, "bbox_y":200, "bbox_w":80, "bbox_h":160}
{"type":"progress",  "frame":100, "total_frames":3000}
{"type":"summary",   "total_detections":482, "total_tracks":14, "duration_s":120.0, "fps":25.0, "width":1920, "height":1080}
```

---

### `detection.ts` — Node.js Detection Orchestrator

| Function | Purpose |
|----------|---------|
| `runDetectionPipeline(videoPath, reportPath)` | Main entry point — decides Python vs mock, collects results, calls report generator. Returns `VideoStats`. |
| `runPythonDetect(videoPath)` | Spawns `detect.py`, parses NDJSON stream, resolves with `{detections, summary}` |
| `runMockPipeline(videoPath, fileSizeBytes)` | Generates synthetic detections for dev/testing without a GPU |
| `generateExcelReport(...)` | Builds the 5-sheet workbook using ExcelJS and writes it to disk |
| `getPythonBin()` | Returns `VISIONTRACK_PYTHON` env var or falls back to `python3` |
| `getModelPath()` | Returns `VISIONTRACK_MODEL` env var or falls back to `yolov8n.pt` |

---

### `routes/jobs.ts` — API Route Handlers

| Route | Handler behaviour |
|-------|-------------------|
| `GET /jobs` | Queries all rows from `jobs` table ordered by `created_at` |
| `POST /upload` | Multer saves file to `uploads/`, inserts `pending` row in DB, returns job |
| `POST /process/:jobId` | Sets status to `processing`, responds immediately, runs pipeline in `setImmediate` (non-blocking) |
| `GET /status/:jobId` | Returns single job row |
| `GET /download/:jobId` | Streams `.xlsx` file with `res.download()` |
| `DELETE /jobs/:jobId` | Deletes DB row, removes video file and report from disk |

---

### `lib/db/src/schema/jobs.ts` — Database Schema

Defined with Drizzle ORM. The `jobsTable` object is used directly in all queries — no raw SQL.

```typescript
status: text("status").notNull().default("pending")
// Values: "pending" | "processing" | "complete" | "failed"
```

`updatedAt` is automatically set to `now()` on every update via `.$onUpdate(() => new Date())`.

---

### `hooks/use-jobs.ts` — Frontend React Hooks

| Hook | Purpose |
|------|---------|
| `useJobs()` | Fetches job list; polls every 2.5s if any job is `pending` or `processing` |
| `useUploadAndProcessVideo()` | XHR upload with progress tracking, then calls `/api/process/:id` |
| `useJobActions()` | `deleteJob(id)`, `downloadReport(id)` — download navigates `window.location.href` |

---

*Generated by VisionTrack project — Replit workspace*
