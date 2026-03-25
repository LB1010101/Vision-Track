# Workspace

## Overview

VisionTrack — a local CCTV video analytics platform. Upload video footage, run mock object detection/tracking, and download structured Excel reports.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite, TailwindCSS, shadcn/ui, react-dropzone, framer-motion
- **Excel generation**: ExcelJS (5-sheet workbook: Summary, Zone Summary, Class Breakdown, Tracks, Raw Detections)
- **File upload**: multer (multipart/form-data, max 2GB)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   │   ├── src/lib/detection.ts   # Mock YOLO detection + Excel report generator
│   │   ├── src/routes/jobs.ts     # Upload, process, status, download, delete endpoints
│   │   ├── uploads/               # Uploaded video files (runtime)
│   │   └── reports/               # Generated Excel reports (runtime)
│   └── visiontrack/        # React + Vite frontend (dark mode surveillance UI)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
│       └── src/schema/jobs.ts  # Jobs table schema
├── scripts/                # Utility scripts (single workspace package)
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## API Endpoints

All endpoints are under `/api`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /healthz | Health check |
| GET | /jobs | List all jobs |
| POST | /upload | Upload video (multipart/form-data, field: `file`) |
| POST | /process/:jobId | Trigger processing pipeline |
| GET | /status/:jobId | Poll job status |
| GET | /download/:jobId | Download Excel report |
| DELETE | /jobs/:jobId | Delete job and files |

## Processing Pipeline

`artifacts/api-server/src/lib/detection.ts` runs a mock YOLO detection pipeline:
1. Estimates video duration from file size
2. Simulates frame-by-frame detection with realistic class distributions (person, car, truck, etc.)
3. Tracks objects across frames with unique IDs
4. Generates 5-sheet Excel report via ExcelJS

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Codegen

Run after any change to `lib/api-spec/openapi.yaml`:
```bash
pnpm --filter @workspace/api-spec run codegen
```

## Database

Push schema changes:
```bash
pnpm --filter @workspace/db run push
```

## Replacing Mock Detection with Real YOLO

Replace `runDetectionPipeline()` in `artifacts/api-server/src/lib/detection.ts` with real YOLO:

```typescript
import { YOLO } from "ultralytics"; // or Axelera SDK

const model = new YOLO("yolov8n.pt");
// Replace the mock loop with model.track(videoPath, { stream: true })
```
