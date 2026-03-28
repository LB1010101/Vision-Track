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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-5xl mx-4 glass-panel rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/[0.03]">
          <div>
            <h3 className="text-white font-display font-semibold tracking-wide text-sm uppercase">
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground border border-primary/20 hover:border-primary transition-all text-xs font-mono"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
            <button
              onClick={onClose}
              className="p-2 rounded-lg bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white border border-white/10 transition-all"
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
            onError={() => {
              const el = videoRef.current;
              if (el) {
                el.insertAdjacentHTML("afterend",
                  `<div class="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground text-sm font-mono p-8 text-center">
                    <p class="text-white mb-2">Playback unavailable in browser.</p>
                    <p>Download the file and open with VLC or another media player.</p>
                  </div>`
                );
              }
            }}
          >
            Your browser does not support the video tag.
          </video>
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 bg-white/[0.02] border-t border-white/5 text-xs text-muted-foreground font-mono flex items-center justify-between">
          <span>Bounding boxes and track IDs rendered by YOLO · Click outside or press Esc to close</span>
          <span className="text-primary/60">Job #{jobId}</span>
        </div>
      </div>
    </div>
  );
}
