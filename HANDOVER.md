# VisionTrack — Handover Document

**Platform:** Lenovo P360 Ultra · Ubuntu · Axelera AI M.2 Card  
**Date:** April 2026  
**Purpose:** Local CCTV video analytics — upload footage, run AI object detection/tracking, download Excel reports, and review annotated video playback.

---

## Table of Contents

1. [What the App Does](#1-what-the-app-does)
2. [System Architecture](#2-system-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Database Schema](#4-database-schema)
5. [API Reference](#5-api-reference)
6. [Detection Pipeline](#6-detection-pipeline)
7. [Excel Report Format](#7-excel-report-format)
8. [Annotated Video Output](#8-annotated-video-output)
9. [Environment Variables](#9-environment-variables)
10. [Running Locally on the P360](#10-running-locally-on-the-p360)
11. [Syncing Code Updates from Replit](#11-syncing-code-updates-from-replit)
12. [One-time Setup Checklist](#12-one-time-setup-checklist)
13. [Enabling Real AI Detection](#13-enabling-real-ai-detection)
14. [Enabling Axelera Hardware Acceleration](#14-enabling-axelera-hardware-acceleration)
15. [Troubleshooting](#15-troubleshooting)
16. [Code Reference](#16-code-reference)
17. [Sales Proposal Documents](#17-sales-proposal-documents)

---

## 1. What the App Does

VisionTrack is a self-hosted web application for analysing CCTV footage using AI:

1. User uploads a video file (`.mp4`, `.avi`, `.mov`, `.mkv`, `.webm`) via a browser.
2. The server runs object detection and tracking on every frame of the video.
3. A multi-sheet Excel report is generated with per-minute timeline, zone breakdowns, class statistics, confidence ranges, and embedded bar/line charts.
4. An annotated copy of the video is created with bounding boxes, class labels, and track IDs drawn on every frame — viewable directly in the browser or downloadable.
5. User downloads the `.xlsx` report and/or watches/downloads the annotated `.mp4` from the browser.

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
        ├── PostgreSQL database  (jobs table — status, paths, stats)
        │
        ├── uploads/             (raw uploaded video files)
        ├── reports/             (generated .xlsx Excel files)
        ├── annotated/           (annotated video output from detect.py)
        │
        └── detect.py  ◄── Python subprocess (spawned per job)
                │
                ├── Axelera Voyager SDK  (if M.2 hardware card present)
                └── Ultralytics YOLO + ByteTrack  (CPU/GPU fallback)
```

- The **frontend** (React + Vite) polls `/api/jobs` every 2.5 seconds while any job is processing.
- The **API server** handles uploads, spawns the Python detection script, writes the database, serves report downloads, and streams annotated video with HTTP range request support.
- The **Python script** streams results back to Node via `stdout` as newline-delimited JSON (NDJSON).
- If Python is unavailable, the API server falls back to a **mock simulation** (useful for testing without a GPU).
- **Detection model:** Ultralytics YOLO26 (`yolo26n.pt` by default) — upgraded from YOLOv8. Model auto-downloads on first use. Override via `VISIONTRACK_MODEL` env var.

---

## 3. Repository Structure

```
Vision-Track/
├── VisionTrack-Proposal.html        ← Sales proposal (open in browser → Ctrl+P to save as PDF)
├── VisionTrack-Proposal.docx        ← Sales proposal (editable Word format)
├── artifacts/
│   ├── api-server/                  ← Express API (Node.js)
│   │   ├── src/
│   │   │   ├── index.ts             ← Server entry point (port binding)
│   │   │   ├── app.ts               ← Express app setup, middleware, CORS
│   │   │   ├── routes/
│   │   │   │   ├── index.ts         ← Route registration
│   │   │   │   ├── jobs.ts          ← Upload, process, status, download, delete, video stream
│   │   │   │   └── health.ts        ← GET /api/healthz
│   │   │   └── lib/
│   │   │       ├── detection.ts     ← Python subprocess + mock pipeline + Excel + chart generation
│   │   │       └── logger.ts        ← Pino logger setup
│   │   ├── detect.py                ← Python detection script (Axelera / YOLO / annotated video)
│   │   ├── requirements.txt         ← Python dependencies
│   │   ├── build.mjs                ← ESBuild config (externalises native .node packages)
│   │   ├── uploads/                 ← Raw video files (created at runtime)
│   │   ├── reports/                 ← Excel reports (created at runtime)
│   │   └── annotated/               ← H.264 annotated videos (created at runtime)
│   │
│   └── visiontrack/                 ← React frontend (Vite, light mode)
│       └── src/
│           ├── pages/
│           │   └── Dashboard.tsx    ← Main page (stats, upload, jobs table)
│           ├── components/
│           │   ├── Layout.tsx       ← Shell with header/nav
│           │   ├── UploadZone.tsx   ← Drag-and-drop upload area with progress bar
│           │   ├── StatsBar.tsx     ← Summary counters (total, processing, complete, failed)
│           │   ├── JobsTable.tsx    ← Table of all jobs with status badges and action buttons
│           │   ├── StatusBadge.tsx  ← Colour-coded status pill (pending/processing/complete/failed)
│           │   └── VideoPlayerModal.tsx ← In-browser video player for annotated footage
│           ├── hooks/
│           │   └── use-jobs.ts      ← React Query hooks (list, upload, delete, download)
│           └── index.css            ← Global styles and CSS variables (light mode theme)
│
├── lib/
│   ├── db/                          ← Drizzle ORM + PostgreSQL
│   │   └── src/schema/jobs.ts       ← jobs table schema definition
│   ├── api-spec/
│   │   └── openapi.yaml             ← OpenAPI 3.0 spec (source of truth for types)
│   ├── api-client-react/            ← Auto-generated React Query hooks (from OpenAPI)
│   └── api-zod/                     ← Auto-generated Zod schemas (from OpenAPI)
│
└── pnpm-workspace.yaml
```

---

## 4. Database Schema

Single table: **`jobs`**

| Column                | Type        | Description                                                    |
|-----------------------|-------------|----------------------------------------------------------------|
| `id`                  | serial PK   | Auto-increment job ID                                          |
| `filename`            | text        | Unique filename on disk (UUID-timestamped)                     |
| `original_name`       | text        | Original filename as uploaded by user                          |
| `status`              | text        | `pending` → `processing` → `complete` / `failed`              |
| `file_size_bytes`     | integer     | Size of the uploaded video in bytes                            |
| `duration_seconds`    | real        | Video duration from ffprobe/OpenCV                             |
| `total_detections`    | integer     | Total detection events across all frames                       |
| `total_tracks`        | integer     | Number of unique tracked objects                               |
| `error_message`       | text        | Error detail if `status = failed`                              |
| `report_path`         | text        | Absolute path to the generated `.xlsx` file                    |
| `annotated_video_path`| text        | Absolute path to the H.264 annotated video (null if not generated) |
| `created_at`          | timestamptz | Job creation time                                              |
| `updated_at`          | timestamptz | Last update time (auto-updated via `$onUpdate`)                |

**Important:** After first clone or any schema change, run:
```bash
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
  pnpm --filter @workspace/db run push
```

---

## 5. API Reference

Base URL: `http://localhost:8080`

| Method | Path                    | Description                                                         |
|--------|-------------------------|---------------------------------------------------------------------|
| GET    | `/api/healthz`          | Health check — returns `{ status: "ok" }`                           |
| GET    | `/api/jobs`             | List all jobs (array, ordered newest first)                         |
| POST   | `/api/upload`           | Upload video — `multipart/form-data` field `file`                   |
| POST   | `/api/process/:jobId`   | Start processing an uploaded job (non-blocking, fires and returns)  |
| GET    | `/api/status/:jobId`    | Get a single job's current status and stats                         |
| GET    | `/api/download/:jobId`  | Download the Excel report (triggers file download)                  |
| GET    | `/api/video/:jobId`     | Stream annotated video with HTTP range request support (for `<video>`) |
| DELETE | `/api/jobs/:jobId`      | Delete job, video file, report, and annotated video from disk       |

**Upload flow:**
`POST /api/upload` → returns job object with `status: pending` → immediately call `POST /api/process/:jobId` → poll `GET /api/jobs` until `status: complete`.

**Supported video formats:** `.mp4` `.avi` `.mov` `.mkv` `.webm`  
**Max file size:** 2 GB

---

## 6. Detection Pipeline

### Node.js side (`artifacts/api-server/src/lib/detection.ts`)

1. Checks if `VISIONTRACK_MOCK=true` is set — if so, runs mock simulation directly.
2. Checks if `detect.py` exists on disk.
3. Spawns `detect.py` as a Python subprocess with environment variables for model, confidence, zones, and annotated video output path (`VISIONTRACK_OUTPUT_VIDEO`).
4. Reads NDJSON from `stdout` line by line:
   - `{"type":"detection", ...}` → collected in memory
   - `{"type":"progress", ...}` → logged for debugging
   - `{"type":"summary", ...}` → stored as final stats (includes annotated video path)
   - `{"type":"log", ...}` → forwarded to server log
   - `{"type":"error", ...}` → logged as error
5. If Python fails or is not found → falls back to mock pipeline (no annotated video).
6. Calls `generateExcelReport()` with all collected detections — produces a 6-sheet workbook with embedded chart images.
7. Returns `VideoStats` including `annotatedVideoPath` (string or null).

### `routes/jobs.ts` annotated path resolution

After `runDetectionPipeline` returns, `routes/jobs.ts` resolves the final annotated video path using a two-step fallback:
1. Use `stats.annotatedVideoPath` if it is a non-empty string.
2. Otherwise check whether the expected file (`annotated/annotated-{jobId}.mp4`) exists on disk and use that path.

This ensures the play button appears even if detection.ts had a path resolution issue.

### Python side (`artifacts/api-server/detect.py`)

Tries inference backends in order:

**1. Axelera Voyager SDK** (`import axelera.runtime`)  
Uses the compiled `.axm` model on the Axelera M.2 AI card. Returns hardware-accelerated bounding boxes with track IDs.

**2. Ultralytics YOLO** (fallback)  
Uses `model.track()` with ByteTrack for multi-object tracking. Automatically downloads `yolo26n.pt` (~6 MB) on first run. Uses `result.plot()` to draw annotations.

**Annotated video:** On every frame, bounding boxes + class labels + track IDs are drawn. OpenCV VideoWriter tries multiple codecs (`avc1`, `H264`, `mp4v`, `XVID`) — the first one that opens successfully is used. The raw output is then re-encoded to H.264 via `ffmpeg -vcodec libx264 +faststart` for browser compatibility. On P360 Ubuntu, hardware H.264 encoding via `h264_v4l2m2m` may produce warnings in stderr — this is harmless; `mp4v` is used as the working codec and re-encoding via libx264 still succeeds.

**Video metadata** is read via `ffprobe` first, then OpenCV, then estimated from file size.

**Zone classification** uses a ray-casting point-in-polygon algorithm. If no zones are configured, defaults to 4 quadrants (NW, NE, SW, SE).

**Note on non-determinism:** YOLO's ByteTrack assigns track IDs dynamically each run. Detection totals will be very similar but not identical between runs on the same video — this is expected behaviour for all YOLO-based trackers.

---

## 7. Excel Report Format

Each report is a `.xlsx` workbook with **6 colour-coded tabs** plus embedded charts:

| Sheet              | Colour | Contents                                                                 |
|--------------------|--------|--------------------------------------------------------------------------|
| **Summary**        | Blue   | File info, duration, resolution, FPS, total detections/tracks, peak activity minute, model, confidence threshold |
| **Zone Summary**   | Green  | Detection count, unique objects, percentage per zone — sorted by frequency. Includes embedded bar chart. |
| **Class Breakdown**| Amber  | Detection count, unique objects, min/max/avg confidence per class. Includes embedded bar chart. |
| **Timeline**       | Purple | Per-minute table: detection count, active objects, top 3 class columns. Peak minute highlighted. Includes embedded line chart. |
| **Tracks**         | Red    | Per tracked object: class, zone, first seen, last seen, duration, detection count, avg confidence |
| **Raw Detections** | Teal   | Frame number, timestamp, track ID, class, zone, confidence, bounding box (x,y,w,h) — sampled to 2000 rows max |

**Embedded charts:** Zone Summary, Class Breakdown, and Timeline sheets each contain an embedded PNG chart image (bar or line), generated server-side using SVG + `@resvg/resvg-js` (WASM renderer — no browser required). Charts are wrapped in `try/catch` so a rendering failure never blocks the report.

**Important — no conditional formatting:** All `addConditionalFormatting` calls have been removed from the codebase. ExcelJS 4.x throws `TypeError: Cannot read properties of undefined (reading 'forEach')` when writing any workbook containing conditional formatting rules. Do not re-add data bar rules.

---

## 8. Annotated Video Output

When a video is processed successfully:

1. `detect.py` draws bounding boxes, class labels, and track IDs on every frame using YOLO's `result.plot()` (or OpenCV for Axelera).
2. A raw annotated video is written to `artifacts/api-server/annotated/annotated-{jobId}.mp4.raw.mp4`.
3. FFmpeg re-encodes it to H.264 with `+faststart` for browser streaming, saving to `annotated/annotated-{jobId}.mp4`.
4. The final absolute path is stored in `annotated_video_path` in the database.
5. A **blue Play button** appears in the jobs table row for completed jobs that have an annotated video.
6. Clicking it opens a modal video player. A Download button in the modal saves the file locally.

The `/api/video/:jobId` endpoint serves the file with `Content-Range` header support so the browser `<video>` element can seek without downloading the entire file.

**If the Play button is missing after processing completes:**
1. Check that `artifacts/api-server/annotated/` exists and contains `annotated-{jobId}.mp4`.
2. If the file exists but the DB column is null, update it manually:
   ```bash
   psql postgresql://visiontrack:visiontrack@localhost:5432/visiontrack -c \
     "UPDATE jobs SET annotated_video_path = '/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/annotated/annotated-{jobId}.mp4' WHERE id = {jobId};"
   ```
3. If the column itself is missing: run `pnpm --filter @workspace/db run push` (see Section 4).

---

## 9. Environment Variables

### API Server

| Variable                 | Default      | Description                                              |
|--------------------------|--------------|----------------------------------------------------------|
| `PORT`                   | **required** | Port the API server listens on (use `8080`)              |
| `DATABASE_URL`           | **required** | PostgreSQL connection string                             |
| `VISIONTRACK_PYTHON`     | `python3`    | Path to Python executable with ultralytics installed     |
| `VISIONTRACK_MODEL`      | `yolo26n.pt` | YOLO model file path (or `.axm` for Axelera)            |
| `VISIONTRACK_CONFIDENCE` | `0.7`        | Minimum detection confidence (0.0–1.0)                  |
| `VISIONTRACK_ZONES`      | *(none)*     | JSON array of named polygon zones (see below)            |
| `VISIONTRACK_MOCK`       | `false`      | Set `true` to skip Python and use simulated data        |

### Frontend

| Variable    | Default      | Description                           |
|-------------|--------------|---------------------------------------|
| `PORT`      | **required** | Port Vite serves on (use `3000`)      |
| `BASE_PATH` | **required** | URL base path (use `/` for local)     |

### Zone format example

```bash
VISIONTRACK_ZONES='[{"name":"Entrance","polygon":[[0,0],[960,0],[960,1080],[0,1080]]},{"name":"Car Park","polygon":[[960,0],[1920,0],[1920,1080],[960,1080]]}]'
```

---

## 10. Running Locally on the P360

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

## 11. Syncing Code Updates from Replit

The Replit internal git remote (`gitsafe-backup`) is not reachable from outside. GitHub is used as a relay.

### GitHub repository

**URL:** `https://github.com/LB1010101/Vision-Track.git`  
**Note:** Both `V` and `T` are capitalised — `Vision-Track`.

### Remote names

| Location | Remote name | URL |
|----------|-------------|-----|
| Replit   | `github`    | `https://github.com/LB1010101/Vision-Track.git` |
| P360     | `origin`    | `https://github.com/LB1010101/Vision-Track.git` |

### Pushing updates from Replit

In the Replit Shell tab:
```bash
git push github master
```

### Pulling updates on P360

```bash
cd ~/Downloads/Vision-Track/Vision-Track
git fetch --depth=1 origin master && git reset --hard FETCH_HEAD
pnpm install
```

Then restart both terminals.

### Setting up P360 remote (first time or if missing)

```bash
cd ~/Downloads/Vision-Track/Vision-Track
git remote add origin https://github.com/LB1010101/Vision-Track.git
# or if it already exists with wrong URL:
git remote set-url origin https://github.com/LB1010101/Vision-Track.git
```

### If git pull fails (network issue) — curl individual files

```bash
BASE="https://raw.githubusercontent.com/LB1010101/Vision-Track/master"
curl -fL "$BASE/artifacts/api-server/src/lib/detection.ts" -o artifacts/api-server/src/lib/detection.ts
curl -fL "$BASE/artifacts/api-server/src/routes/jobs.ts" -o artifacts/api-server/src/routes/jobs.ts
curl -fL "$BASE/artifacts/api-server/detect.py" -o artifacts/api-server/detect.py
curl -fL "$BASE/artifacts/api-server/build.mjs" -o artifacts/api-server/build.mjs
pnpm install
```

Then restart Terminal 1.

---

## 12. One-time Setup Checklist

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

# 5. Create database user and database
sudo -u postgres psql -c "CREATE USER visiontrack WITH PASSWORD 'visiontrack';"
sudo -u postgres psql -c "CREATE DATABASE visiontrack OWNER visiontrack;"

# 6. Apply database schema (creates all tables including annotated_video_path column)
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
  pnpm --filter @workspace/db run push

# 7. ffmpeg (for video metadata and H.264 re-encoding of annotated video)
sudo apt install -y ffmpeg

# 8. Python venv + YOLO dependencies
cd ~/Downloads/Vision-Track/Vision-Track/artifacts/api-server
python3 -m venv .venv
.venv/bin/pip install ultralytics opencv-python numpy

# 9. Set up GitHub remote for future updates
cd ~/Downloads/Vision-Track/Vision-Track
git remote add origin https://github.com/LB1010101/Vision-Track.git
```

---

## 13. Enabling Real AI Detection

Once the Python venv is set up (step 8 above), pass `VISIONTRACK_PYTHON` when starting the API server:

```bash
VISIONTRACK_PYTHON=/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/.venv/bin/python3
```

On first use, `yolo26n.pt` (~6 MB) is downloaded automatically from Ultralytics.

**Model options** (larger = more accurate, slower):

```bash
VISIONTRACK_MODEL=yolo26n.pt    # nano — fastest (default)
VISIONTRACK_MODEL=yolo26s.pt    # small — good balance
VISIONTRACK_MODEL=yolo26m.pt    # medium — better accuracy
VISIONTRACK_MODEL=yolo26l.pt    # large — high accuracy, slow
```

**Confidence threshold** (default 0.7 — only 70%+ confident detections):

```bash
VISIONTRACK_CONFIDENCE=0.5   # looser — catches more, may include noise
VISIONTRACK_CONFIDENCE=0.7   # default — high quality only
VISIONTRACK_CONFIDENCE=0.85  # very strict — only very clear detections
```

---

## 14. Enabling Axelera Hardware Acceleration

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

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Command 'pnpm' not found` | pnpm not installed | `sudo npm install -g pnpm` |
| `Vite requires Node.js 20+` | Node.js 18 still active | Re-run the NodeSource setup for v22 |
| `Cannot find native binding` | node_modules built for wrong Node version | `rm -rf node_modules && pnpm install` |
| `DATABASE_URL must be set` | Env var missing | Add `DATABASE_URL=postgresql://...` to start command |
| `relation "jobs" does not exist` | Tables not created | Run `pnpm --filter @workspace/db run push` |
| `column "annotated_video_path" does not exist` | Schema not migrated after feature was added | Run `DATABASE_URL=... pnpm --filter @workspace/db run push` |
| `connect ECONNREFUSED 127.0.0.1:8080` | API server not running | Start Terminal 1 first, wait for `Server listening` |
| `Upload failed: Internal Server Error` | API server error | Check Terminal 1 output for actual error |
| Report contains mock/simulated data | Python not found | Set `VISIONTRACK_PYTHON` to your venv's python3 path |
| Excel report write error / `undefined.forEach()` | Conditional formatting rules present | Ensure NO `addConditionalFormatting` calls exist in `detection.ts` — they have been removed and must not be re-added |
| Port 3000 already in use | Old Vite process still running | Vite picks next port automatically (3001…) — use whatever it prints |
| `jobs.filter is not a function` | API server not reachable | Check ECONNREFUSED — start API server first |
| No Play button on completed job | `annotated_video_path` column missing in DB | Run `pnpm --filter @workspace/db run push` then manually update the row via psql (see Section 8) |
| No Play button — column exists but is null | Old `routes/jobs.ts` called pipeline without annotated path arg | Do a full `git reset --hard` on P360 to get latest code |
| Play button appears but video won't load | FFmpeg not installed | `sudo apt install -y ffmpeg` |
| OpenCV H264/avc1 codec warnings in Terminal 1 | Hardware H.264 encoder not available on P360 | Harmless — `mp4v` is used as fallback; FFmpeg re-encodes to H.264 libx264 successfully |
| Chart images missing from Excel report | `@resvg/resvg-js` not installed | Run `pnpm install` after pulling latest code |
| `fatal: 'origin' does not appear to be a git repository` | P360 git remote not configured | `git remote add origin https://github.com/LB1010101/Vision-Track.git` |
| `git pull` drops connection mid-transfer | Network buffer issue | Use `git fetch --depth=1 origin master && git reset --hard FETCH_HEAD` |
| `yolo26n.pt` download fails / times out | No internet on first run | Pre-download: `python3 -c "from ultralytics import YOLO; YOLO('yolo26n.pt')"` on a connected machine, then copy the file to the working directory |
| `Model 'yolo26n.pt' not found` | Ultralytics version doesn't support YOLO26 | `pip install --upgrade ultralytics` in the venv, or override `VISIONTRACK_MODEL=yolov8n.pt` to fall back |

---

## 16. Code Reference

### `detect.py` — Python Detection Script

**Entry point:** `main()`

| Function | Purpose |
|----------|---------|
| `get_video_metadata(path)` | Returns `(width, height, duration_s, fps)` — tries ffprobe, then OpenCV, then estimates from file size |
| `parse_zones(json_str)` | Parses `VISIONTRACK_ZONES` env var into a list of `{name, polygon}` dicts |
| `classify_zone(cx, cy, zones, w, h)` | Returns the zone name for a centroid point; defaults to 4 quadrants if no zones configured |
| `point_in_polygon(x, y, polygon)` | Ray-casting algorithm — returns True if point is inside polygon |
| `make_video_writer(path, fps, w, h)` | Creates an OpenCV VideoWriter, tries multiple codecs (avc1, H264, mp4v, XVID) |
| `reencode_with_ffmpeg(input, output)` | Re-encodes a video to H.264 MP4 with `+faststart` for browser streaming |
| `run_with_axelera(...)` | Attempts Axelera Voyager SDK inference; returns `None` if SDK not installed |
| `run_with_ultralytics(...)` | Runs YOLO26 + ByteTrack; draws annotations using `result.plot()`; writes annotated video |
| `emit(obj)` | Writes a JSON object to `stdout` immediately (flush=True) |

**Output format (NDJSON on stdout):**
```json
{"type":"log",       "message":"Processing: myvideo.mp4"}
{"type":"log",       "message":"Video: 1920x1080 @ 25.0fps, 120.0s"}
{"type":"detection", "frame":0, "timestamp_s":0.0, "track_id":1, "class":"person", "zone":"Zone A (NW)", "confidence":0.87, "bbox_x":120, "bbox_y":200, "bbox_w":80, "bbox_h":160}
{"type":"progress",  "frame":100, "total_frames":3000}
{"type":"summary",   "total_detections":482, "total_tracks":14, "duration_s":120.0, "fps":25.0, "width":1920, "height":1080, "annotated_video_path":"/abs/path/annotated/annotated-1.mp4"}
```

---

### `detection.ts` — Node.js Detection Orchestrator

| Function | Purpose |
|----------|---------|
| `runDetectionPipeline(videoPath, reportPath, annotatedVideoPath)` | Main entry point — decides Python vs mock, collects results, calls report and chart generators. Returns `VideoStats`. |
| `runPythonDetect(videoPath, annotatedVideoPath)` | Spawns `detect.py` with `VISIONTRACK_OUTPUT_VIDEO` env var, parses NDJSON stream, resolves with `{detections, summary}` |
| `runMockPipeline(videoPath, fileSizeBytes)` | Generates synthetic detections for dev/testing without a GPU or Python |
| `generateExcelReport(...)` | Builds the 6-sheet workbook using ExcelJS, embeds chart PNG images, writes to disk |
| `generateBarChartSvg(data, title, color)` | Generates a vertical bar chart as an SVG string (no external rendering required) |
| `generateLineChartSvg(data, title, color)` | Generates a line/area chart as an SVG string |
| `svgToPng(svg)` | Converts SVG string to PNG Buffer using `@resvg/resvg-js` (WASM — no browser needed) |
| `getPythonBin()` | Returns `VISIONTRACK_PYTHON` env var or falls back to `python3` |
| `getModelPath()` | Returns `VISIONTRACK_MODEL` env var or falls back to `yolo26n.pt` |

---

### `routes/jobs.ts` — API Route Handlers

| Route | Handler behaviour |
|-------|-------------------|
| `GET /jobs` | Queries all rows from `jobs` table ordered by `created_at` desc |
| `POST /upload` | Multer saves file to `uploads/`, inserts `pending` row in DB, returns job object |
| `POST /process/:jobId` | Sets status to `processing`, responds `200` immediately, runs pipeline in `setImmediate` (non-blocking) |
| `GET /status/:jobId` | Returns single job row |
| `GET /download/:jobId` | Streams `.xlsx` file using `res.download()` |
| `GET /video/:jobId` | Streams annotated `.mp4` with HTTP range request support (enables `<video>` seeking) |
| `DELETE /jobs/:jobId` | Deletes DB row, removes video file, report, and annotated video from disk |

**Annotated path resolution (after pipeline returns):**
```typescript
const savedAnnotatedPath =
  stats.annotatedVideoPath ||
  (fs.existsSync(annotatedVideoPath) ? annotatedVideoPath : null);
```
This two-step fallback ensures the path is saved even if `detection.ts` returned null.

---

### `lib/db/src/schema/jobs.ts` — Database Schema

Defined with Drizzle ORM. The `jobsTable` object is used directly in all queries — no raw SQL needed.

```typescript
status: text("status").notNull().default("pending")
// Values: "pending" | "processing" | "complete" | "failed"

annotatedVideoPath: text("annotated_video_path")
// Absolute path to H.264 annotated video; null if generation failed or column missing
```

`updatedAt` is automatically set to `now()` on every update via `.$onUpdate(() => new Date())`.

---

### `VideoPlayerModal.tsx` — In-browser Video Player

Renders a modal overlay with:
- A `<video>` element pointing at `/api/video/:jobId` (range-request streaming)
- A Download button (direct `href` to the same endpoint)
- Keyboard support (Escape to close)
- Click-outside-to-close behaviour

Only shown when a job has `annotatedVideoPath` set (Play button visible in `JobsTable.tsx`).

---

### `hooks/use-jobs.ts` — Frontend React Hooks

| Hook | Purpose |
|------|---------|
| `useJobs()` | Fetches job list; polls every 2.5s if any job is `pending` or `processing` |
| `useUploadAndProcessVideo()` | XHR upload with `onUploadProgress` tracking; calls `/api/process/:id` after upload |
| `useJobActions()` | `deleteJob(id)`, `downloadReport(id)` (navigates `window.location.href`), `onWatchVideo` callback |

---

## 17. Sales Proposal Documents

Two ready-to-send proposal files are included in the project root and also served statically from `artifacts/visiontrack/public/`:

| File | Format | Purpose |
|------|--------|---------|
| `VisionTrack-Proposal.html` | HTML | Open in any browser; use Ctrl+P → Save as PDF to produce a print-ready PDF |
| `VisionTrack-Proposal.docx` | Word | Editable in Microsoft Word or LibreOffice |

### Contents

Both documents cover:
- Executive summary and key capabilities
- Five-stage pipeline overview
- Six-sheet Excel report format description
- Configurable detection zones
- Technology stack table
- Deployment model and hardware requirements
- ZAR pricing (Pay Per Job + Prepaid Hour Credits)
- Add-on services
- Three-step next steps guide
- Contact section

### Current client details

| Field | Value |
|-------|-------|
| Prepared For | ABC Media |
| Contact Email | info@visiontrack.co.za |
| Deployment Timeline | 1 day after project kickoff |

### Updating the Word document

The `.docx` is a binary file — do not use `sed` to patch it. To update content, regenerate it via the `docx` npm package in the `code_execution` sandbox, then copy the output to both `VisionTrack-Proposal.docx` (project root) and `artifacts/visiontrack/public/VisionTrack-Proposal.docx`.

---

*Generated by VisionTrack project — Replit workspace — April 2026*
