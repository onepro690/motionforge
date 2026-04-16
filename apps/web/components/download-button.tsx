"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { forceDownload } from "@/lib/utils";
import { toast } from "sonner";

interface DownloadButtonProps {
  url: string;
  filename: string;
  label?: string;
  size?: "sm" | "default" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost";
  className?: string;
  iconOnly?: boolean;
}

export function DownloadButton({
  url,
  filename,
  label = "Download",
  size = "sm",
  variant = "outline",
  className,
  iconOnly = false,
}: DownloadButtonProps) {
  const [downloading, setDownloading] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try {
      await forceDownload(url, filename);
    } catch {
      toast.error("Erro ao baixar arquivo");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={handleClick}
      disabled={downloading}
    >
      {downloading ? (
        <Loader2 className={`w-3 h-3 animate-spin${iconOnly ? "" : " mr-1.5"}`} />
      ) : (
        <Download className={`w-3 h-3${iconOnly ? "" : " mr-1.5"}`} />
      )}
      {!iconOnly && (downloading ? "Baixando..." : label)}
    </Button>
  );
}
