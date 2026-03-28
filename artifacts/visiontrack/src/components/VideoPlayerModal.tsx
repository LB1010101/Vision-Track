import { useEffect, useRef } from "react";
import { X, Download } from "lucide-react";

interface VideoPlayerModalProps {
  jobId: number;
  filename: string;
  onClose: () => void;
}

export function VideoPlayerModal({ jobId, filename, onClose }: VideoPlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const videoSrc = `/api/video/${jobId}`;
  const downloadName = `annotated-${filename.replace(/\.[^.]+$/, "")}.mp4`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-5xl mx-4 bg-card rounded-2xl border border-border overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/40">
          <div>
            <h3 className="text-foreground font-display font-semibold tracking-wide text-sm uppercase">
              Annotated Footage
            </h3>
            <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate max-w-md" title={filename}>
              {filename}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={videoSrc}
              download={downloadName}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white border border-primary/20 hover:border-primary transition-all text-xs font-mono"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border transition-all"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Video */}
        <div className="bg-black relative">
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            autoPlay
            className="w-full max-h-[70vh] object-contain"
          >
            Your browser does not support the video tag.
          </video>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-muted/30 border-t border-border text-xs text-muted-foreground font-mono flex items-center justify-between">
          <span>Bounding boxes and track IDs rendered by YOLO · Click outside or press Esc to close</span>
          <span className="text-primary/70">Job #{jobId}</span>
        </div>
      </div>
    </div>
  );
}
