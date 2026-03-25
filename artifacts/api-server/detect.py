#!/usr/bin/env python3
"""
VisionTrack Detection Script
Runs object detection + tracking on a video file using:
  1. Axelera Voyager SDK (if installed and hardware available)
  2. Ultralytics YOLO (CPU/GPU fallback)

Outputs newline-delimited JSON to stdout:
  - Each detection: {"type":"detection", "frame":N, "timestamp_s":F, "track_id":N, ...}
  - Progress updates: {"type":"progress", "frame":N, "total_frames":N}
  - Final summary: {"type":"summary", "total_detections":N, "total_tracks":N, "duration_s":F, "fps":F, "width":N, "height":N}
  - Errors: {"type":"error", "message":"..."}

Usage:
  python3 detect.py <video_path> [model_path] [zones_json]

Environment variables:
  VISIONTRACK_MODEL      Path to model file (default: yolov8n.pt)
  VISIONTRACK_CONFIDENCE Minimum confidence threshold (default: 0.35)
  VISIONTRACK_DEVICE     Device override: 'cpu', 'cuda', 'axelera' (default: auto-detect)
  VISIONTRACK_ZONES      JSON array of zone polygons, e.g.: '[{"name":"Zone A","polygon":[[0,0],[960,0],[960,540],[0,540]]}]'
"""

import sys
import json
import os
import math
import time

def emit(obj):
    """Write a JSON object to stdout immediately."""
    print(json.dumps(obj), flush=True)

def emit_error(msg):
    emit({"type": "error", "message": msg})

def get_video_metadata(video_path):
    """Get video metadata using ffprobe or OpenCV fallback."""
    import subprocess
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", "-select_streams", "v:0", video_path
            ],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            stream = data["streams"][0]
            width = int(stream.get("width", 1920))
            height = int(stream.get("height", 1080))
            duration = float(stream.get("duration", 0))
            r_frame_rate = stream.get("r_frame_rate", "25/1")
            num, den = r_frame_rate.split("/")
            fps = float(num) / float(den) if float(den) != 0 else 25.0
            return width, height, duration, fps
    except Exception:
        pass

    # Fallback: OpenCV
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_frames / fps if fps > 0 else 0
        cap.release()
        return width, height, duration, fps
    except Exception:
        pass

    # Last resort estimate from file size
    file_size = os.path.getsize(video_path)
    estimated_duration = max(10.0, file_size / (500 * 1024))
    return 1920, 1080, estimated_duration, 25.0

def parse_zones(zones_json_str):
    """Parse zone polygons from JSON string."""
    if not zones_json_str:
        return []
    try:
        return json.loads(zones_json_str)
    except Exception:
        return []

def classify_zone(cx, cy, zones, frame_width, frame_height):
    """Classify a point (cx, cy) into the first matching zone polygon using ray casting."""
    if not zones:
        # Default 4-quadrant zones when none configured
        half_w = frame_width / 2
        half_h = frame_height / 2
        if cx < half_w and cy < half_h:
            return "Zone A (NW)"
        elif cx >= half_w and cy < half_h:
            return "Zone B (NE)"
        elif cx < half_w and cy >= half_h:
            return "Zone C (SW)"
        else:
            return "Zone D (SE)"

    for zone in zones:
        polygon = zone.get("polygon", [])
        if point_in_polygon(cx, cy, polygon):
            return zone.get("name", "Unknown Zone")
    return "Outside Zones"

def point_in_polygon(x, y, polygon):
    """Ray casting algorithm for point-in-polygon test."""
    if len(polygon) < 3:
        return False
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def run_with_axelera(video_path, model_path, confidence, zones, frame_width, frame_height):
    """
    Run inference using Axelera Voyager SDK.
    Returns list of detection dicts.
    """
    try:
        # Try to import Axelera Voyager SDK
        # The SDK exposes a Pipeline class that wraps compiled .axm models
        import axelera.runtime as axrt

        emit({"type": "log", "message": "Axelera Voyager SDK detected — using hardware accelerator"})

        pipeline = axrt.Pipeline(model_path)

        import cv2
        cap = cv2.VideoCapture(video_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        detections = []
        frame_idx = 0

        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            results = pipeline.infer(frame)

            for det in results.detections:
                if det.confidence < confidence:
                    continue
                cx = int((det.x1 + det.x2) / 2)
                cy = int((det.y1 + det.y2) / 2)
                zone = classify_zone(cx, cy, zones, frame_width, frame_height)
                d = {
                    "type": "detection",
                    "frame": frame_idx,
                    "timestamp_s": round(frame_idx / fps, 3),
                    "track_id": int(getattr(det, "track_id", -1)),
                    "class": str(det.class_name),
                    "zone": zone,
                    "confidence": round(float(det.confidence), 4),
                    "bbox_x": int(det.x1),
                    "bbox_y": int(det.y1),
                    "bbox_w": int(det.x2 - det.x1),
                    "bbox_h": int(det.y2 - det.y1),
                }
                detections.append(d)
                emit(d)

            if frame_idx % 100 == 0:
                emit({"type": "progress", "frame": frame_idx, "total_frames": total_frames})

            frame_idx += 1

        cap.release()
        return detections, fps, total_frames

    except ImportError:
        return None  # Signal to fall back to Ultralytics

def run_with_ultralytics(video_path, model_path, confidence, zones, frame_width, frame_height, fps):
    """
    Run inference using Ultralytics YOLO with ByteTrack.
    Returns list of detection dicts.
    """
    from ultralytics import YOLO
    import cv2

    emit({"type": "log", "message": f"Using Ultralytics YOLO — model: {os.path.basename(model_path)}"})

    model = YOLO(model_path)

    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    detections = []
    frame_idx = 0

    # model.track handles reading the video + tracking via ByteTrack
    results_gen = model.track(
        source=video_path,
        stream=True,
        persist=True,
        conf=confidence,
        tracker="bytetrack.yaml",
        verbose=False,
    )

    for result in results_gen:
        boxes = result.boxes
        if boxes is not None and len(boxes) > 0:
            for box in boxes:
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
                cx = int((x1 + x2) / 2)
                cy = int((y1 + y2) / 2)
                zone = classify_zone(cx, cy, zones, frame_width, frame_height)
                track_id = int(box.id[0]) if box.id is not None else -1
                cls_idx = int(box.cls[0])
                cls_name = model.names.get(cls_idx, f"class_{cls_idx}")
                conf = round(float(box.conf[0]), 4)

                d = {
                    "type": "detection",
                    "frame": frame_idx,
                    "timestamp_s": round(frame_idx / fps, 3),
                    "track_id": track_id,
                    "class": cls_name,
                    "zone": zone,
                    "confidence": conf,
                    "bbox_x": int(x1),
                    "bbox_y": int(y1),
                    "bbox_w": int(x2 - x1),
                    "bbox_h": int(y2 - y1),
                }
                detections.append(d)
                emit(d)

        if frame_idx % 100 == 0:
            emit({"type": "progress", "frame": frame_idx, "total_frames": max(total_frames, 1)})

        frame_idx += 1

    return detections

def main():
    if len(sys.argv) < 2:
        emit_error("Usage: detect.py <video_path> [model_path]")
        sys.exit(1)

    video_path = sys.argv[1]
    if not os.path.exists(video_path):
        emit_error(f"Video file not found: {video_path}")
        sys.exit(1)

    model_path = (
        sys.argv[2] if len(sys.argv) > 2
        else os.environ.get("VISIONTRACK_MODEL", "yolov8n.pt")
    )
    confidence = float(os.environ.get("VISIONTRACK_CONFIDENCE", "0.35"))
    zones_json = os.environ.get("VISIONTRACK_ZONES", "")
    zones = parse_zones(zones_json)

    emit({"type": "log", "message": f"Processing: {os.path.basename(video_path)}"})

    # Get real video metadata
    frame_width, frame_height, duration_s, fps = get_video_metadata(video_path)
    emit({"type": "log", "message": f"Video: {frame_width}x{frame_height} @ {fps:.1f}fps, {duration_s:.1f}s"})

    detections = []

    # 1. Try Axelera Voyager SDK
    result = run_with_axelera(video_path, model_path, confidence, zones, frame_width, frame_height)
    if result is not None:
        detections, fps, _ = result
    else:
        # 2. Fall back to Ultralytics YOLO
        detections = run_with_ultralytics(video_path, model_path, confidence, zones, frame_width, frame_height, fps)

    # Compute unique track IDs
    track_ids = set(d["track_id"] for d in detections if d["track_id"] >= 0)

    emit({
        "type": "summary",
        "total_detections": len(detections),
        "total_tracks": len(track_ids),
        "duration_s": round(duration_s, 3),
        "fps": round(fps, 3),
        "width": frame_width,
        "height": frame_height,
    })

if __name__ == "__main__":
    main()
