import { useState, useCallback } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { 
  useListJobs, 
  getListJobsQueryKey, 
  processJob,
  useDeleteJob,
  type Job
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export function useJobs() {
  // Use the generated hook but override options to enable polling
  return useListJobs({
    query: {
      refetchInterval: (query) => {
        const jobs = query.state.data as Job[] | undefined;
        const needsPolling = jobs?.some(
          job => job.status === 'pending' || job.status === 'processing'
        );
        return needsPolling ? 2500 : false;
      },
    }
  });
}

export function useUploadAndProcessVideo() {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadAndProcess = useCallback(async (file: File) => {
    setIsUploading(true);
    setProgress(0);

    try {
      // 1. Upload via XHR for progress
      const formData = new FormData();
      formData.append('file', file);

      const uploadedJob = await new Promise<Job>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percentComplete = (event.loaded / event.total) * 100;
            setProgress(Math.round(percentComplete));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (e) {
              reject(new Error("Invalid response from server"));
            }
          } else {
            reject(new Error(`Upload failed: ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        
        xhr.open("POST", "/api/upload", true);
        xhr.send(formData);
      });

      toast({
        title: "Upload Complete",
        description: "Initiating analysis pipeline...",
      });

      // 2. Trigger Processing
      await processJob(uploadedJob.id);
      
      // Invalidate list to show new processing job
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      
      toast({
        title: "Processing Started",
        description: `Analyzing ${file.name}...`,
      });

    } catch (error) {
      console.error("Upload error:", error);
      toast({
        title: "Upload Failed",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      setProgress(0);
    }
  }, [queryClient, toast]);

  return {
    uploadAndProcess,
    isUploading,
    progress
  };
}

export function useJobActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const deleteMutation = useDeleteJob();

  const removeJob = async (jobId: number) => {
    try {
      await deleteMutation.mutateAsync({ jobId });
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      toast({
        title: "Job Deleted",
        description: "The video and its data have been removed.",
      });
    } catch (error) {
      toast({
        title: "Deletion Failed",
        description: "Could not remove the job.",
        variant: "destructive",
      });
    }
  };

  const downloadReport = (jobId: number) => {
    // Navigate to the download endpoint directly to trigger browser download
    window.location.href = `/api/download/${jobId}`;
  };

  return {
    deleteJob: removeJob,
    isDeleting: deleteMutation.isPending,
    downloadReport
  };
}
