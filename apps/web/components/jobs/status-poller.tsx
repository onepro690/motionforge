"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface StatusPollerProps {
  jobId: string;
  initialStatus: string;
}

export function JobStatusPoller({ jobId, initialStatus }: StatusPollerProps) {
  const router = useRouter();

  useEffect(() => {
    const activeStatuses = ["QUEUED", "PROCESSING", "RENDERING"];
    if (!activeStatuses.includes(initialStatus)) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();
        if (!activeStatuses.includes(job.status)) {
          clearInterval(interval);
        }
        router.refresh();
      } catch {
        // ignore
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [jobId, initialStatus, router]);

  return null;
}
