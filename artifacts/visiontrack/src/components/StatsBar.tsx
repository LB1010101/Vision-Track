import { Activity, Database, CheckCircle2, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Job } from "@workspace/api-client-react";

interface StatsBarProps {
  jobs: Job[] | undefined;
}

export function StatsBar({ jobs = [] }: StatsBarProps) {
  const total = jobs.length;
  const processing = jobs.filter(j => j.status === 'processing' || j.status === 'pending').length;
  const completed = jobs.filter(j => j.status === 'complete').length;
  const failed = jobs.filter(j => j.status === 'failed').length;

  const stats = [
    {
      label: "Total Jobs",
      value: total,
      icon: Database,
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-200"
    },
    {
      label: "Processing",
      value: processing,
      icon: Activity,
      color: "text-primary",
      bg: "bg-primary/10",
      border: "border-primary/20",
      pulse: processing > 0
    },
    {
      label: "Completed",
      value: completed,
      icon: CheckCircle2,
      color: "text-success",
      bg: "bg-success/10",
      border: "border-success/20"
    },
    {
      label: "Failed",
      value: failed,
      icon: AlertOctagon,
      color: "text-destructive",
      bg: "bg-destructive/10",
      border: "border-destructive/20"
    }
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {stats.map((stat, i) => (
        <div
          key={i}
          className="glass-panel rounded-2xl p-5 relative overflow-hidden group hover:shadow-md transition-shadow"
        >
          <div className={cn(
            "absolute -inset-px opacity-0 group-hover:opacity-60 transition-opacity duration-500 rounded-2xl blur-md -z-10",
            stat.bg
          )} />

          <div className="flex justify-between items-start mb-4 relative z-10">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{stat.label}</p>
            <div className={cn("p-2 rounded-xl border", stat.bg, stat.color, stat.border)}>
              <stat.icon className={cn("w-5 h-5", stat.pulse && "animate-pulse-slow")} />
            </div>
          </div>
          <div className="flex items-baseline gap-2 relative z-10">
            <h3 className="text-4xl font-display font-bold text-foreground tracking-tight">{stat.value}</h3>
          </div>
        </div>
      ))}
    </div>
  );
}
