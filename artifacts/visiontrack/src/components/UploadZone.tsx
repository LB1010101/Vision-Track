import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileVideo, Loader2 } from "lucide-react";
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
          isDragActive ? "border-primary bg-primary/5 shadow-[0_0_30px_rgba(var(--primary),0.15)]" : "border-white/10 bg-card/40 hover:bg-card/60 hover:border-white/20",
          isDragReject && "border-destructive bg-destructive/5",
          isUploading && "pointer-events-none border-primary/30 bg-card/20"
        )}
      >
        <input {...getInputProps()} />
        
        {/* Scanning effect line when drag active */}
        <AnimatePresence>
          {isDragActive && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 pointer-events-none z-0"
            >
              <div className="w-full h-1 bg-primary/50 shadow-[0_0_15px_rgba(var(--primary),1)] animate-scan" />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative z-10 flex flex-col items-center">
          <div className={cn(
            "w-20 h-20 rounded-full flex items-center justify-center mb-6 transition-all duration-300",
            isDragActive ? "bg-primary/20 scale-110" : "bg-white/5 group-hover:scale-105 group-hover:bg-white/10"
          )}>
            {isUploading ? (
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
            ) : (
              <Upload className={cn(
                "w-10 h-10 transition-colors",
                isDragActive ? "text-primary text-glow" : "text-muted-foreground group-hover:text-white"
              )} />
            )}
          </div>
          
          <h3 className="text-2xl font-display font-semibold mb-2 text-white">
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
                <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden backdrop-blur-sm">
                  <motion.div 
                    className="h-full bg-gradient-to-r from-primary/50 to-primary shadow-[0_0_10px_rgba(var(--primary),0.8)] relative"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ type: "tween", duration: 0.2 }}
                  >
                    <div className="absolute inset-0 bg-white/20 w-full animate-pulse" />
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
