import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface UploadZoneProps {
  onUpload: (file: File) => void;
  isUploading: boolean;
  progress: number;
}

export function UploadZone({ onUpload, isUploading, progress }: UploadZoneProps) {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0 && !isUploading) {
      onUpload(acceptedFiles[0]);
    }
  }, [onUpload, isUploading]);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: {
      'video/*': ['.mp4', '.avi', '.mov', '.mkv']
    },
    maxFiles: 1,
    disabled: isUploading
  });

  return (
    <div className="mb-8">
      <div
        {...getRootProps()}
        className={cn(
          "relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-300 ease-out p-12 cursor-pointer flex flex-col items-center justify-center text-center group",
          isDragActive
            ? "border-primary bg-primary/5 shadow-[0_0_20px_rgba(59,130,246,0.12)]"
            : "border-border bg-card hover:bg-muted/30 hover:border-primary/40",
          isDragReject && "border-destructive bg-destructive/5",
          isUploading && "pointer-events-none border-primary/30 bg-muted/20"
        )}
      >
        <input {...getInputProps()} />

        <AnimatePresence>
          {isDragActive && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 pointer-events-none z-0"
            >
              <div className="w-full h-1 bg-primary/40 animate-scan" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative z-10 flex flex-col items-center">
          <div className={cn(
            "w-20 h-20 rounded-full flex items-center justify-center mb-6 transition-all duration-300",
            isDragActive ? "bg-primary/15 scale-110" : "bg-muted group-hover:scale-105 group-hover:bg-primary/10"
          )}>
            {isUploading ? (
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
            ) : (
              <Upload className={cn(
                "w-10 h-10 transition-colors",
                isDragActive ? "text-primary" : "text-muted-foreground group-hover:text-primary"
              )} />
            )}
          </div>

          <h3 className="text-2xl font-display font-semibold mb-2 text-foreground">
            {isUploading
              ? "Uploading & Analyzing..."
              : isDragActive
                ? "Drop target acquired"
                : "Initialize Analysis"}
          </h3>

          <p className="text-muted-foreground font-mono text-sm max-w-md">
            {isUploading
              ? "Do not close this window. Pipeline is processing the video stream."
              : "Drag and drop CCTV footage here, or click to browse files. Supports MP4, AVI, MOV, MKV."}
          </p>

          <AnimatePresence>
            {isUploading && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 24 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                className="w-full max-w-md"
              >
                <div className="flex justify-between text-xs font-mono mb-2 text-primary">
                  <span>DATA_TRANSFER</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-primary/70 to-primary relative"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ type: "tween", duration: 0.2 }}
                  >
                    <div className="absolute inset-0 bg-white/30 w-full animate-pulse" />
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
