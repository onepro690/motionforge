import path from "path";
import fs from "fs/promises";

export interface PreprocessResult {
  videoPath: string;
  imagePath: string;
  videoMetadata: {
    duration: number;
    fps: number;
    width: number;
    height: number;
  };
  imageMetadata: {
    width: number;
    height: number;
  };
}

export async function preprocessInputs(
  videoUrl: string,
  imageUrl: string,
  workDir: string
): Promise<PreprocessResult> {
  await fs.mkdir(workDir, { recursive: true });

  const videoPath = await downloadFile(
    videoUrl,
    path.join(workDir, "input_video.mp4")
  );
  const imagePath = await downloadFile(
    imageUrl,
    path.join(workDir, "input_image.jpg")
  );

  const videoMetadata = await extractVideoMetadata(videoPath);
  const imageMetadata = await extractImageMetadata(imagePath);

  return { videoPath, imagePath, videoMetadata, imageMetadata };
}

async function downloadFile(url: string, destPath: string): Promise<string> {
  // Handle local file paths (starting with /)
  if (url.startsWith("/") || url.startsWith("file://")) {
    const sourcePath = url.startsWith("file://") ? url.slice(7) : url;
    try {
      await fs.copyFile(sourcePath, destPath);
      return destPath;
    } catch {
      // fall through to HTTP fetch
    }
  }

  // Handle http/https URLs
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to download ${url}: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
    return destPath;
  }

  // Handle local storage API paths like /api/uploads/...
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const fullUrl = `${appUrl}${url}`;
  const response = await fetch(fullUrl);
  if (!response.ok) {
    // Try direct file path as fallback
    const storagePath = process.env.STORAGE_LOCAL_PATH ?? "./uploads";
    const localPath = url.replace("/api/uploads/", storagePath + "/");
    await fs.copyFile(localPath, destPath);
    return destPath;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destPath, buffer);
  return destPath;
}

async function extractVideoMetadata(
  _videoPath: string
): Promise<PreprocessResult["videoMetadata"]> {
  // In production, use ffprobe for real metadata extraction
  return { duration: 5.0, fps: 30, width: 1280, height: 720 };
}

async function extractImageMetadata(
  _imagePath: string
): Promise<PreprocessResult["imageMetadata"]> {
  return { width: 512, height: 512 };
}
