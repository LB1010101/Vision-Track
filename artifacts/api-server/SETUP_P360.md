# VisionTrack — Lenovo P360 Setup Guide (Ubuntu + Axelera AI)

## Overview

VisionTrack runs the **Node.js API server** with a **Python subprocess** for detection.
The Python script (`detect.py`) tries the Axelera Voyager SDK first, then falls back to Ultralytics YOLO.

---

## 1. System Prerequisites

```bash
sudo apt update && sudo apt install -y \
  ffmpeg \
  python3 python3-pip python3-venv \
  libgl1 libglib2.0-0   # OpenCV runtime deps
```

## 2. Python Setup

```bash
cd /path/to/visiontrack/artifacts/api-server

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install base dependencies
pip install -r requirements.txt
```

## 3. Axelera Voyager SDK Setup

Follow your Axelera installation guide to install the runtime SDK.
After installation, verify it's available in the same virtual environment:

```bash
python3 -c "import axelera.runtime; print('Voyager SDK OK')"
```

If this works, VisionTrack will automatically use the Axelera M.2 card for inference.

## 4. Model Setup

### Option A: Axelera-compiled model (recommended for hardware acceleration)
Compile your YOLOv8 model using the Voyager SDK toolchain:
```bash
axelera compile --model yolov8n.pt --output yolov8n_axelera.axm
```
Set the path via environment variable:
```bash
export VISIONTRACK_MODEL=/path/to/yolov8n_axelera.axm
```

### Option B: Standard YOLO model (CPU/GPU fallback)
```bash
# Downloads automatically on first use
export VISIONTRACK_MODEL=yolov8n.pt      # nano (fastest)
export VISIONTRACK_MODEL=yolov8s.pt      # small
export VISIONTRACK_MODEL=yolov8m.pt      # medium
export VISIONTRACK_MODEL=yolov8l.pt      # large
```

## 5. Environment Variables

Set these in your shell or in a `.env` file before starting the server:

| Variable | Default | Description |
|----------|---------|-------------|
| `VISIONTRACK_PYTHON` | `python3` | Path to Python executable (use `.venv/bin/python3`) |
| `VISIONTRACK_MODEL` | `yolov8n.pt` | Path to YOLO or Axelera compiled model |
| `VISIONTRACK_CONFIDENCE` | `0.35` | Minimum detection confidence (0.0–1.0) |
| `VISIONTRACK_ZONES` | _(quadrants)_ | JSON zone polygons (see below) |
| `VISIONTRACK_MOCK` | `false` | Force mock pipeline (for testing without hardware) |

### Zone Configuration

Define custom zones as a JSON array of polygons (pixel coordinates matching your camera resolution):

```bash
export VISIONTRACK_ZONES='[
  {"name": "Entrance", "polygon": [[0,0],[640,0],[640,720],[0,720]]},
  {"name": "Parking Lot", "polygon": [[640,0],[1920,0],[1920,1080],[640,1080]]},
  {"name": "Loading Bay", "polygon": [[800,400],[1200,400],[1200,800],[800,800]]}
]'
```

## 6. Starting the Server

```bash
# From the visiontrack project root
export VISIONTRACK_PYTHON=/path/to/.venv/bin/python3
export VISIONTRACK_MODEL=/path/to/yolov8n_axelera.axm  # or yolov8n.pt

pnpm --filter @workspace/api-server run dev
```

Or for production:
```bash
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

## 7. Testing the Detection

```bash
# Test with a sample video
curl -X POST http://localhost:8080/api/upload \
  -F "file=@/path/to/test.mp4"

# Returns job JSON with id
# Then trigger processing:
curl -X POST http://localhost:8080/api/process/1

# Poll status:
curl http://localhost:8080/api/status/1

# Download report when complete:
curl -o report.xlsx http://localhost:8080/api/download/1
```

## 8. Verifying Axelera Hardware is in Use

Check the server logs after uploading a video. If the Voyager SDK is detected:
```
INFO: Axelera Voyager SDK detected — using hardware accelerator
```

If falling back to CPU:
```
INFO: Using Ultralytics YOLO — model: yolov8n.pt
```

## 9. Replacing Detection Classes / Logic

Edit `detect.py` to customise the detection pipeline:
- **Classes**: YOLO models detect their training classes automatically
- **Tracking**: ByteTrack is used by default (`tracker="bytetrack.yaml"`)
- **Zones**: Set `VISIONTRACK_ZONES` env var (see above)
- **Axelera-specific inference**: Update `run_with_axelera()` to match your SDK version's API

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Failed to spawn python3` | Set `VISIONTRACK_PYTHON` to the full path of your Python executable |
| `No module named 'ultralytics'` | Activate venv and run `pip install ultralytics` |
| `No module named 'axelera'` | Follow Axelera Voyager SDK installation guide |
| Report missing / processing stuck | Check server logs for Python stderr output |
| CUDA out of memory | Use a smaller model (`yolov8n.pt`) or add `device='cpu'` |
| Slow inference | Ensure Axelera model is compiled (`.axm` format) and hardware is detected |
