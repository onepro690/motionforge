import { cn, getStatusLabel, getStatusColor } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function JobStatusBadge({ status, className }: StatusBadgeProps) {
  const isLoading = ["PROCESSING", "RENDERING", "QUEUED"].includes(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
        getStatusColor(status),
        className
      )}
    >
      {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
      {getStatusLabel(status)}
    </span>
  );
}
