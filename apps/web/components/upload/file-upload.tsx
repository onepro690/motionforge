"use client";
import { useCallback, useState, useRef } from "react";
import {
  Upload,
  X,
  FileVideo,
  ImageIcon,
  CheckCircle,
  Loader2,
  ClipboardPaste,
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { toast } from "sonner";
import { upload } from "@vercel/blob/client";

interface FileUploadProps {
  accept: string;
  maxSize: number;
  label: string;
  hint: string;
  icon: "video" | "image";
  value?: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
  supportsPaste?: boolean;
}

export interface UploadedFile {
  url: string;
  name: string;
  size: number;
  mimeType: string;
  duration?: number; // seconds, only for video files
}

export function FileUpload({
  accept,
  maxSize,
  label,
  hint,
  icon,
  value,
  onChange,
  supportsPaste = false,
}: FileUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > maxSize) {
        toast.error(
          `Arquivo muito grande. Máximo: ${formatBytes(maxSize)}`
        );
        return;
      }

      // Extract video duration before uploading
      let fileDuration: number | undefined;
      if (icon === "video" && file.type.startsWith("video/")) {
        fileDuration = await new Promise<number>((resolve) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          const objectUrl = URL.createObjectURL(file);
          video.onloadedmetadata = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(video.duration);
          };
          video.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(0);
          };
          video.src = objectUrl;
        });
      }

      setUploading(true);
      setProgress(0);

      const fileType = icon === "video" ? "input_video" : "input_image";

      try {
        // Client-side upload directly to Vercel Blob — bypasses the 4.5MB
        // serverless function body limit entirely.
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/upload",
          clientPayload: fileType,
          onUploadProgress: ({ percentage }) => {
            setProgress(Math.round(percentage));
          },
        });

        onChange({
          url: blob.url,
          name: file.name,
          size: file.size,
          mimeType: file.type,
          duration: fileDuration,
        });
        toast.success("Arquivo enviado com sucesso!");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Erro no upload"
        );
        onChange(null);
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [maxSize, icon, onChange]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      e.target.value = "";
    },
    [handleFile]
  );

  const handlePasteClick = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], "pasted-image.png", { type: imageType });
          handleFile(file);
          return;
        }
      }
      toast.error("Nenhuma imagem na área de transferência");
    } catch {
      toast.error("Não foi possível acessar a área de transferência");
    }
  }, [handleFile]);

  if (value) {
    return (
      <div className="relative rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-violet-500/10 flex items-center justify-center flex-shrink-0">
            {icon === "video" ? (
              <FileVideo className="w-5 h-5 text-violet-400" />
            ) : (
              <ImageIcon className="w-5 h-5 text-violet-400" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">
              {value.name}
            </p>
            <p className="text-xs text-white/40">{formatBytes(value.size)}</p>
          </div>
          <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
          <button
            onClick={() => onChange(null)}
            className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleInputChange}
      />
      <div
        className={cn(
          "upload-zone rounded-xl p-8 text-center cursor-pointer",
          dragging && "dragging"
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {uploading ? (
          <div className="space-y-3">
            <Loader2 className="w-8 h-8 text-violet-400 animate-spin mx-auto" />
            <p className="text-sm text-white/60">Enviando... {progress}%</p>
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="w-12 h-12 rounded-xl bg-violet-500/10 flex items-center justify-center mx-auto mb-4">
              <Upload className="w-6 h-6 text-violet-400" />
            </div>
            <p className="text-white font-medium mb-1">{label}</p>
            <p className="text-white/40 text-sm">{hint}</p>
            <p className="text-white/25 text-xs mt-2">
              Máximo {formatBytes(maxSize)}
            </p>
            {supportsPaste && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void handlePasteClick(); }}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.10] text-white/50 hover:text-white hover:bg-white/[0.10] transition-colors text-xs"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                Colar imagem (Ctrl+V)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
