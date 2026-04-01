# Workspace

## Overview

VisionTrack — a local CCTV video analytics platform deployed on a Lenovo P360 running Ubuntu with an Axelera AI M.2 card.

Users upload video footage via a browser. The server runs object detection and tracking (Axelera Voyager SDK → Ultralytics YOLO26 + ByteTrack → mock fallback), generates a 6-sheet Excel analytics report with embedded charts, and produces an annotated video with bounding boxes for post-processing review.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 22 (required on P360; Vite needs v20+)
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec `lib/api-spec/openapi.yaml`)
- **Build**: esbuild (ESM bundle; native `.node` packages and `@resvg/resvg-js` externalised in `build.mjs`)
- **Frontend**: React + Vite, TailwindCSS, react-dropzone, framer-motion — light mode theme
- **Excel generation**: ExcelJS 4.x — 6-sheet workbook with embedded PNG charts (no conditional formatting — all `addConditionalFormatting` calls removed due to ExcelJS 4.x bug)
- **Chart rendering**: `@resvg/resvg-js` (WASM SVG→PNG renderer — no browser/canvas native bindings needed)
- **File upload**: multer (multipart/form-data, max 2 GB)
- **Detection model**: Ultralytics YOLO26 (`yolo26n.pt` default) — upgraded from YOLOv8; auto-downloaded on first run
- **Video annotation**: Python `detect.py` via subprocess — YOLO26 `result.plot()` + FFmpeg H.264 re-encode

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/                       # Express API (Node.js)
│   │   ├── src/lib/detection.ts          # Python subprocess + mock pipeline + Excel + chart generation
│   │   ├── src/routes/jobs.ts            # Upload, process, download, delete, video stream endpoints
│   │   ├── detect.py                     # Python: Axelera → YOLO → annotated video output
│   │   ├── build.mjs                     # esbuild config (externalises @resvg/resvg-js and *.node)
│   │   ├── uploads/                      # Raw uploaded video files (runtime)
│   │   ├── reports/                      # Generated Excel reports (runtime)
│   │   └── annotated/                    # H.264 annotated video output (runtime)
│   └── visiontrack/                      # React + Vite frontend (light mode)
│       └── src/
│           ├── pages/Dashboard.tsx       # Main page
│           ├── components/
│           │   ├── Layout.tsx            # Header/shell
│           │   ├── StatsBar.tsx          # Job counters
│           │   ├── UploadZone.tsx        # Drag-and-drop upload
│           │   ├── JobsTable.tsx         # Jobs list with Play/Download/Delete buttons
│           │   ├── StatusBadge.tsx       # Status pill component
│           │   └── VideoPlayerModal.tsx  # In-browser annotated video player
│           ├── hooks/use-jobs.ts         # React Query data hooks
│           └── index.css                 # CSS variables (light mode palette) + Tailwind
├── lib/
│   ├── api-spec/openapi.yaml             # OpenAPI 3.0 spec (source of truth for types)
│   ├── api-client-react/                 # Generated React Query hooks (Orval)
│   ├── api-zod/                          # Generated Zod schemas (Orval)
│   └── db/src/schema/jobs.ts             # Drizzle jobs table (includes annotated_video_path column)
├── scripts/
├── pnpm-workspace.yaml
├── tsconfig.base.json                    # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json                         # Root project references
├── package.json                          # Root package with hoisted devDeps
├── HANDOVER.md                           # Full handover doc for P360 deployment
├── VisionTrack-Proposal.html             # Sales proposal (HTML — open in browser, Ctrl+P to save as PDF)
└── VisionTrack-Proposal.docx             # Sales proposal (Word — editable; regenerated via code_execution)
```

**Proposal files are also served statically** from `artifacts/visiontrack/public/` so they are browser-accessible during development.

## API Endpoints

All endpoints are under `/api`:

| Method | Endpoint             | Description                                                        |
|--------|----------------------|--------------------------------------------------------------------|
| GET    | /healthz             | Health check                                                       |
| GET    | /jobs                | List all jobs (ordered newest first)                               |
| POST   | /upload              | Upload video (multipart/form-data, field: `file`)                  |
| POST   | /process/:jobId      | Trigger detection pipeline (non-blocking, fires and returns 202)   |
| GET    | /status/:jobId       | Poll single job status                                             |
| GET    | /download/:jobId     | Download Excel report                                              |
| GET    | /video/:jobId        | Stream annotated video with HTTP range request support             |
| DELETE | /jobs/:jobId         | Delete job, video, report, and annotated video from disk           |

## Processing Pipeline

1. `POST /upload` saves video to `uploads/`, creates `pending` DB row
2. `POST /process/:jobId` fires `setImmediate` (non-blocking) and returns immediately
3. Inside `setImmediate`, `runDetectionPipeline()` in `detection.ts`:
   - Spawns `detect.py` as a Python subprocess with `VISIONTRACK_OUTPUT_VIDEO` env var set to the expected annotated video path
   - `detect.py` runs: Axelera Voyager SDK → Ultralytics YOLO + ByteTrack → mock fallback
   - `detect.py` streams NDJSON to stdout (`detection`, `progress`, `log`, `summary`, `error` types)
   - `detect.py` also writes an annotated video to `annotated/` and re-encodes to H.264 via FFmpeg
   - Node collects all detections and the summary message
   - `generateExcelReport()` produces a 6-sheet `.xlsx` with embedded SVG→PNG charts
4. `routes/jobs.ts` checks both `stats.annotatedVideoPath` (from detect.py summary) and the expected path on disk as a fallback, then saves to DB
5. DB row updated: `status=complete`, stats, `report_path`, `annotated_video_path`

## Database Schema

Single table `jobs`. Key columns:

| Column                 | Type     | Notes                                              |
|------------------------|----------|----------------------------------------------------|
| `status`               | text     | `pending` / `processing` / `complete` / `failed`   |
| `annotated_video_path` | text     | Absolute path to H.264 annotated MP4; null if N/A  |
| `report_path`          | text     | Absolute path to generated `.xlsx`                 |
| `total_detections`     | integer  | Frame-level detection events                       |
| `total_tracks`         | integer  | Unique tracked objects (distinct track IDs)        |

Push schema changes to the P360 database (required after first pull or schema updates):
```bash
DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack \
  pnpm --filter @workspace/db run push
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — only `.d.ts` files are emitted during typecheck
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array
- **Note**: The build uses esbuild (not tsc) and does NOT perform type checking. TypeScript errors will not fail the build — only runtime errors will surface.

## Codegen

Run after any change to `lib/api-spec/openapi.yaml`:
```bash
pnpm --filter @workspace/api-spec run codegen
```

## Known Gotchas

- **ExcelJS conditional formatting completely removed**: All `addConditionalFormatting` calls have been removed from `generateExcelReport`. ExcelJS 4.x throws `TypeError: Cannot read properties of undefined (reading 'forEach')` when writing any workbook that contains conditional formatting rules — regardless of the properties passed. Do not re-add data bar rules.
- **`@resvg/resvg-js` must be externalised in `build.mjs`**: It uses a platform-specific `.node` native binding. The `external` array in `build.mjs` lists all `@resvg/resvg-js*` variants.
- **Vite proxy**: `vite.config.ts` proxies `/api` → `localhost:8080` only when `REPL_ID` env var is absent (i.e. on P360, not in Replit cloud).
- **Non-deterministic tracking**: ByteTrack assigns track IDs dynamically; results vary slightly between runs on the same video. This is expected.
- **Annotated video requires FFmpeg**: `sudo apt install -y ffmpeg` on P360.
- **DB schema must be pushed on first setup**: Run `pnpm --filter @workspace/db run push` after first clone or after any schema change. Missing the `annotated_video_path` column will silently cause the play button not to appear.
- **GitHub sync required for P360 updates**: The Replit `gitsafe-backup` remote is not reachable externally. Push to GitHub (`git push github master`) then pull on P360.
- **esbuild does not type-check**: Mismatched function call signatures will compile silently and only fail at runtime. When adding parameters to exported functions, always update all callers.
- **Word proposal is a binary `.docx`**: `sed` cannot patch it. To update content, use the `docx` npm package via `code_execution` and regenerate the file — then copy it to `artifacts/visiontrack/public/`.
- **YOLO26 model auto-downloads on first run**: `yolo26n.pt` is pulled from Ultralytics servers the first time `detect.py` runs on the P360. Ensure internet access is available for first use, or pre-download to the working directory.

## P360 Startup Commands

Terminal 1 (API server):
```bash
PORT=8080 DATABASE_URL=postgresql://visiontrack:visiontrack@localhost:5432/visiontrack VISIONTRACK_PYTHON=/home/ubuntu/Downloads/Vision-Track/Vision-Track/artifacts/api-server/.venv/bin/python3 pnpm --filter @workspace/api-server run dev
```

Terminal 2 (frontend):
```bash
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/visiontrack run dev
```

## GitHub Remote

- **Replit remote name**: `github`
- **P360 remote name**: `origin`
- **URL**: `https://github.com/LB1010101/Vision-Track.git` (capital V and T)

Push from Replit Shell: `git push github master`  
Pull on P360: `git fetch --depth=1 origin master && git reset --hard FETCH_HEAD`
