import { Download, Trash2, FileVideo, AlertCircle, Play } from "lucide-react";
import { format } from "date-fns";
import { formatBytes, formatDuration } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import type { Job } from "@workspace/api-client-react";

interface JobsTableProps {
  jobs: Job[] | undefined;
  isLoading: boolean;
  onDelete: (id: number) => void;
  onDownload: (id: number) => void;
  onWatchVideo: (job: Job) => void;
  isDeleting: boolean;
}

export function JobsTable({ jobs, isLoading, onDelete, onDownload, onWatchVideo, isDeleting }: JobsTableProps) {

  if (isLoading) {
    return (
      <div className="glass-panel rounded-2xl p-12 flex flex-col items-center justify-center text-muted-foreground">
        <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin mb-4" />
        <p className="font-mono text-sm uppercase tracking-widest text-primary animate-pulse">Loading Logs...</p>
      </div>
    );
  }

  if (!jobs || jobs.length === 0) {
    return (
      <div className="glass-panel rounded-2xl border-dashed border-white/10 p-16 flex flex-col items-center justify-center text-muted-foreground text-center">
        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
          <FileVideo className="w-8 h-8 opacity-50" />
        </div>
        <h3 className="text-xl font-display text-white mb-2">No Analysis Logs Found</h3>
        <p className="max-w-sm text-sm">Upload video footage above to initialize the detection pipeline and generate reports.</p>
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/5">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs uppercase bg-white/[0.02] border-b border-white/10 text-muted-foreground font-mono tracking-wider">
            <tr>
              <th className="px-6 py-4 font-medium">Source File</th>
              <th className="px-6 py-4 font-medium">Status</th>
              <th className="px-6 py-4 font-medium">Metrics</th>
              <th className="px-6 py-4 font-medium">Results</th>
              <th className="px-6 py-4 font-medium">Timestamp</th>
              <th className="px-6 py-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-white/[0.02] transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-card border border-white/10 flex items-center justify-center shrink-0">
                      <FileVideo className="w-5 h-5 text-primary/70" />
                    </div>
                    <div className="max-w-[200px]">
                      <div className="font-medium text-white truncate" title={job.originalName}>
                        {job.originalName}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">
                        {job.fileSizeBytes ? formatBytes(job.fileSizeBytes) : '--'}
                      </div>
                    </div>
                  </div>
                </td>

                <td className="px-6 py-4">
                  <StatusBadge status={job.status} />
                  {job.errorMessage && (
                    <div className="mt-2 text-xs text-destructive flex items-start gap-1 max-w-[200px]">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span className="truncate" title={job.errorMessage}>{job.errorMessage}</span>
                    </div>
                  )}
                </td>

                <td className="px-6 py-4 font-mono text-xs">
                  <div className="flex flex-col gap-1 text-muted-foreground">
                    <div><span className="text-white/40 mr-2">DUR:</span> <span className="text-white">{job.durationSeconds ? formatDuration(job.durationSeconds) : '--'}</span></div>
                  </div>
                </td>

                <td className="px-6 py-4 font-mono text-xs">
                  <div className="flex flex-col gap-1 text-muted-foreground">
                    <div><span className="text-white/40 mr-2">DET:</span> <span className="text-primary">{job.totalDetections ?? '--'}</span></div>
                    <div><span className="text-white/40 mr-2">OBJ:</span> <span className="text-white">{job.totalTracks ?? '--'}</span></div>
                  </div>
                </td>

                <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                  {format(new Date(job.createdAt), 'MMM dd, HH:mm:ss')}
                </td>

                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {job.status === 'complete' && job.annotatedVideoPath && (
                      <button
                        onClick={() => onWatchVideo(job)}
                        className="p-2 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500 hover:text-white border border-blue-500/20 hover:border-blue-500 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                        title="Watch Annotated Video"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    {job.status === 'complete' && (
                      <button
                        onClick={() => onDownload(job.id)}
                        className="p-2 rounded-lg bg-success/10 text-success hover:bg-success hover:text-success-foreground border border-success/20 hover:border-success transition-all focus:outline-none focus:ring-2 focus:ring-success/50"
                        title="Download Excel Report"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(job.id)}
                      disabled={isDeleting}
                      className="p-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground border border-destructive/20 hover:border-destructive transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-destructive/50"
                      title="Delete Job"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
