import { useState } from "react";
import { Layout } from "@/components/Layout";
import { StatsBar } from "@/components/StatsBar";
import { UploadZone } from "@/components/UploadZone";
import { JobsTable } from "@/components/JobsTable";
import { VideoPlayerModal } from "@/components/VideoPlayerModal";
import { useJobs, useUploadAndProcessVideo, useJobActions } from "@/hooks/use-jobs";
import type { Job } from "@workspace/api-client-react";

export default function Dashboard() {
  const { data: jobs, isLoading: isJobsLoading } = useJobs();
  const { uploadAndProcess, isUploading, progress } = useUploadAndProcessVideo();
  const { deleteJob, isDeleting, downloadReport } = useJobActions();
  const [watchingJob, setWatchingJob] = useState<Job | null>(null);

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-white tracking-wide">TELEMETRY OVERVIEW</h2>
          <p className="text-muted-foreground text-sm font-mono mt-1">System status and active analysis pipelines</p>
        </div>
      </div>

      <StatsBar jobs={jobs} />

      <UploadZone
        onUpload={uploadAndProcess}
        isUploading={isUploading}
        progress={progress}
      />

      <div className="mb-4 mt-12 flex items-center justify-between">
        <h2 className="text-xl font-display font-semibold text-white tracking-wide flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-primary inline-block shadow-[0_0_8px_rgba(var(--primary),0.8)]" />
          ANALYSIS LOGS
        </h2>
      </div>

      <JobsTable
        jobs={jobs}
        isLoading={isJobsLoading}
        onDelete={deleteJob}
        onDownload={downloadReport}
        onWatchVideo={setWatchingJob}
        isDeleting={isDeleting}
      />

      {watchingJob && (
        <VideoPlayerModal
          jobId={watchingJob.id}
          filename={watchingJob.originalName}
          onClose={() => setWatchingJob(null)}
        />
      )}
    </Layout>
  );
}
