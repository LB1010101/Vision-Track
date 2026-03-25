import { cn } from "@/lib/utils";
import { Loader2, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import type { JobStatus } from "@workspace/api-client-react";

export function StatusBadge({ status }: { status: JobStatus }) {
  switch (status) {
    case 'complete':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/10 border border-success/20 text-success text-xs font-mono font-medium uppercase tracking-wider">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Complete
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono font-medium uppercase tracking-wider">
          <AlertCircle className="w-3.5 h-3.5" />
          Failed
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-mono font-medium uppercase tracking-wider">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Processing
        </span>
      );
    case 'pending':
    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted border border-white/10 text-muted-foreground text-xs font-mono font-medium uppercase tracking-wider">
          <Clock className="w-3.5 h-3.5" />
          Pending
        </span>
      );
  }
}
