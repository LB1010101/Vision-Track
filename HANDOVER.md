# VisionTrack — Handover Document

**Platform:** Lenovo P360 Ultra · Ubuntu · Axelera AI M.2 Card  
**Date:** March 2026  
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

---

## 1. What the App Does

VisionTrack is a self-hosted web application for analysing CCTV footage using AI:

1. User uploads a video file (`.mp4`, `.avi`, `.mov`, `.mkv`, `.webm`) via a browser.
2. The server runs object detection and tracking on every frame of the video.
3. A multi-sheet Excel report is generated with per-minute timeline, zone breakdowns, class statistics, confidence ranges, and embedded bar/line charts.
4. An annotated copy of the video is created with bounding boxes, class labels, and track IDs drawn on every frame — viewable directly in the browser or downloadable.
5. User downloads the `.xlsx` report and/or the annotated `.mp4` from the browser.

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

---

## 3. Repository Structure

```
Vision-Track/
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
3. Spawns `detect.py` as a Python subprocess with environment variables for model, confidence, zones, and annotated video output path.
4. Reads NDJSON from `stdout` line by line:
   - `{"type":"detection", ...}` → collected in memory
   - `{"type":"progress", ...}` → logged for debugging
   - `{"type":"summary", ...}` → stored as final stats (includes annotated video path)
   - `{"type":"log", ...}` → forwarded to server log
   - `{"type":"error", ...}` → logged as error
5. If Python fails or is not found → falls back to mock pipeline.
6. Calls `generateExcelReport()` with all collected detections — produces a 6-sheet workbook with embedded chart images.

### Python side (`artifacts/api-server/detect.py`)

Tries inference backends in order:

**1. Axelera Voyager SDK** (`import axelera.runtime`)  
Uses the compiled `.axm` model on the Axelera M.2 AI card. Returns hardware-accelerated bounding boxes with track IDs.

**2. Ultralytics YOLO** (fallback)  
Uses `model.track()` with ByteTrack for multi-object tracking. Automatically downloads `yolov8n.pt` (~6 MB) on first run. Uses `result.plot()` to draw annotations.

**Annotated video:** On every frame, bounding boxes + class labels + track IDs are drawn. The raw output is re-encoded to H.264 via FFmpeg for browser compatibility.

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

**Data bars:** All count columns have in-cell data bar conditional formatting for quick visual comparison.

**Embedded charts:** Zone Summary, Class Breakdown, and Timeline sheets each contain an embedded PNG chart image (bar or line), generated server-side using SVG + `@resvg/resvg-js` (WASM renderer — no browser required).

**Important:** ExcelJS 4.x does not support the `gradient` or `border` properties on data bar rules — these must not be passed to `addConditionalFormatting` or it will throw `undefined.forEach()` at write time.

---

## 8. Annotated Video Output

When a video is processed successfully:

1. `detect.py` draws bounding boxes, class labels, and track IDs on every frame using YOLO's `result.plot()` (or OpenCV for Axelera).
2. A raw annotated video is written to `artifacts/api-server/annotated/<jobId>_annotated.raw.mp4`.
3. FFmpeg re-encodes it to H.264 with `+faststart` for browser streaming.
4. The final path is stored in `annotated_video_path` in the database.
5. A **blue Play button** appears in the jobs table for completed jobs that have an annotated video.
6. Clicking it opens a modal video player. A Download button in the modal saves the file.

The `/api/video/:jobId` endpoint serves the file with `Content-Range` header support so the browser `<video>` element can seek without downloading the entire file.

---

## 9. Environment Variables

### API Server

| Variable                 | Default      | Description                                              |
|--------------------------|--------------|----------------------------------------------------------|
| `PORT`                   | **required** | Port the API server listens on (use `8080`)              |
| `DATABASE_URL`           | **required** | PostgreSQL connection string                             |
| `VISIONTRACK_PYTHON`     | `python3`    | Path to Python executable with ultralytics installed     |
| `VISIONTRACK_MODEL`      | `yolov8n.pt` | YOLO model file path (or `.axm` for Axelera)            |
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

The Replit internal git remote (`gitsafe-backup`) is not reachable from outside. Use GitHub as a relay.

### One-time setup

1. Create a private repo at github.com (e.g. `vision-track`)
2. In the Replit Shell, push:
   ```bash
   git remote set-url github https://github.com/LB1010101/vision-track.git
   git push github master
   ```
   Use your GitHub Personal Access Token as the password (Settings → Developer settings → Tokens (classic) → `repo` scope).

3. On P360, point the remote to GitHub:
   ```bash
   git remote set-url gitsafe-backup https://github.com/LB1010101/vision-track.git
   ```

### Ongoing updates

After changes in Replit (push from Replit Shell):
```bash
git push github master
```

On P360 to pull updates:
```bash
git config --global http.postBuffer 524288000
git fetch --depth=1 gitsafe-backup master
git reset --hard FETCH_HEAD
pnpm install
```

Then restart both terminals.

### If git pull fails (network issue)

Download individual files directly:
```bash
BASE="https://raw.githubusercontent.com/LB1010101/vision-track/master"
curl -fL "$BASE/artifacts/api-server/src/lib/detection.ts" -o artifacts/api-server/src/lib/detection.ts
curl -fL "$BASE/artifacts/api-server/detect.py" -o artifacts/api-server/detect.py
curl -fL "$BASE/artifacts/api-server/build.mjs" -o artifacts/api-server/build.mjs
curl -fL "$BASE/artifacts/api-server/package.json" -o artifacts/api-server/package.json
curl -fL "$BASE/artifacts/visiontrack/src/index.css" -o artifacts/visiontrack/src/index.css
# ... add other specific files as needed
pnpm install
```

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

# 6. Create database tables
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
  pnpm --filter @workspace/db run push

# 7. ffmpeg (for video metadata and H.264 re-encoding of annotated video)
sudo apt install -y ffmpeg

# 8. Python venv + YOLO dependencies
cd ~/Downloads/Vision-Track/Vision-Track/artifacts/api-server
python3 -m venv .venv
.venv/bin/pip install ultralytics opencv-python numpy
```

---

## 13. Enabling Real AI Detection

Once the Python venv is set up (step 8 above), pass `VISIONTRACK_PYTHON` when starting the API server:

```bash
VISIONTRACK_PYTHON=/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/.venv/bin/python3
```

On first use, `yolov8n.pt` (~6 MB) is downloaded automatically from Ultralytics.

**Model options** (larger = more accurate, slower):

```bash
VISIONTRACK_MODEL=yolov8n.pt    # nano — fastest (default)
VISIONTRACK_MODEL=yolov8s.pt    # small — good balance
VISIONTRACK_MODEL=yolov8m.pt    # medium — better accuracy
VISIONTRACK_MODEL=yolov8l.pt    # large — high accuracy, slow
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
| `connect ECONNREFUSED 127.0.0.1:8080` | API server not running | Start Terminal 1 first, wait for `Server listening` |
| `Upload failed: Internal Server Error` | API server error | Check Terminal 1 output for actual error |
| Report contains mock/simulated data | Python not found | Set `VISIONTRACK_PYTHON` to your venv's python3 path |
| `TypeError: Cannot read properties of undefined (reading 'forEach')` | Unsupported ExcelJS properties | Ensure `gradient`/`border` are NOT passed to `addConditionalFormatting` data bar rules |
| Port 3000 already in use | Old Vite process still running | Vite picks next port automatically (3001…) — use whatever it prints |
| `jobs.filter is not a function` | API server not reachable | Check ECONNREFUSED — start API server first |
| No Play button on completed job | Job processed before annotated video feature was added | Re-process the video to generate annotated output |
| Chart images missing from Excel report | `@resvg/resvg-js` not installed | Run `pnpm install` after pulling latest code |
| `git pull` drops connection mid-transfer | Network buffer issue | Use `git fetch --depth=1 gitsafe-backup master && git reset --hard FETCH_HEAD` |

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
| `run_with_ultralytics(...)` | Runs YOLOv8 + ByteTrack; draws annotations using `result.plot()`; writes annotated video |
| `emit(obj)` | Writes a JSON object to `stdout` immediately (flush=True) |

**Output format (NDJSON on stdout):**
```json
{"type":"log",       "message":"Processing: myvideo.mp4"}
{"type":"log",       "message":"Video: 1920x1080 @ 25.0fps, 120.0s"}
{"type":"detection", "frame":0, "timestamp_s":0.0, "track_id":1, "class":"person", "zone":"Zone A (NW)", "confidence":0.87, "bbox_x":120, "bbox_y":200, "bbox_w":80, "bbox_h":160}
{"type":"progress",  "frame":100, "total_frames":3000}
{"type":"summary",   "total_detections":482, "total_tracks":14, "duration_s":120.0, "fps":25.0, "width":1920, "height":1080, "annotated_video_path":"/abs/path/annotated/1_annotated.mp4"}
```

---

### `detection.ts` — Node.js Detection Orchestrator

| Function | Purpose |
|----------|---------|
| `runDetectionPipeline(videoPath, reportPath, annotatedVideoPath)` | Main entry point — decides Python vs mock, collects results, calls report and chart generators. Returns `VideoStats`. |
| `runPythonDetect(videoPath, annotatedVideoPath)` | Spawns `detect.py`, parses NDJSON stream, resolves with `{detections, summary}` |
| `runMockPipeline(videoPath, fileSizeBytes)` | Generates synthetic detections for dev/testing without a GPU or Python |
| `generateExcelReport(...)` | Builds the 6-sheet workbook using ExcelJS, embeds chart PNG images, writes to disk |
| `generateBarChartSvg(data, title, color)` | Generates a vertical bar chart as an SVG string (no external rendering required) |
| `generateLineChartSvg(data, title, color)` | Generates a line/area chart as an SVG string |
| `svgToPng(svg)` | Converts SVG string to PNG Buffer using `@resvg/resvg-js` (WASM — no browser needed) |
| `getPythonBin()` | Returns `VISIONTRACK_PYTHON` env var or falls back to `python3` |
| `getModelPath()` | Returns `VISIONTRACK_MODEL` env var or falls back to `yolov8n.pt` |
| `esc(s)` | XML-escapes a string for safe SVG text content |
| `formatTime(seconds)` | Formats seconds as `M:SS` for timeline display |

---

### `routes/jobs.ts` — API Route Handlers

| Route | Handler behaviour |
|-------|-------------------|
| `GET /jobs` | Queries all rows from `jobs` table ordered by `created_at` desc |
| `POST /upload` | Multer saves file to `uploads/`, inserts `pending` row in DB, returns job object |
| `POST /process/:jobId` | Sets status to `processing`, responds `202` immediately, runs pipeline in `setImmediate` (non-blocking) |
| `GET /status/:jobId` | Returns single job row |
| `GET /download/:jobId` | Streams `.xlsx` file using `res.download()` |
| `GET /video/:jobId` | Streams annotated `.mp4` with HTTP range request support (enables `<video>` seeking) |
| `DELETE /jobs/:jobId` | Deletes DB row, removes video file, report, and annotated video from disk |

---

### `lib/db/src/schema/jobs.ts` — Database Schema

Defined with Drizzle ORM. The `jobsTable` object is used directly in all queries — no raw SQL needed.

```typescript
status: text("status").notNull().default("pending")
// Values: "pending" | "processing" | "complete" | "failed"

annotatedVideoPath: text("annotated_video_path")
// Absolute path to H.264 annotated video; null if generation failed or not yet supported
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

*Generated by VisionTrack project — Replit workspace — March 2026*
