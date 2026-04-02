import fs from "fs/promises";
import path from "path";

const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_VIDEO_DURATION = 60; // seconds

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export async function validateInputs(
  videoPath: string,
  imagePath: string,
  maxDuration: number
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Check video file
  try {
    const videoStats = await fs.stat(videoPath);
    if (videoStats.size > MAX_VIDEO_SIZE) {
      errors.push(
        `Video file too large: ${(videoStats.size / 1024 / 1024).toFixed(1)}MB (max 500MB)`
      );
    }
    const videoExt = path.extname(videoPath).toLowerCase();
    if (![".mp4", ".mov", ".webm"].includes(videoExt)) {
      errors.push(
        `Invalid video format: ${videoExt}. Accepted: mp4, mov, webm`
      );
    }
  } catch {
    errors.push("Video file not accessible");
  }

  // Check image file
  try {
    const imageStats = await fs.stat(imagePath);
    if (imageStats.size > MAX_IMAGE_SIZE) {
      errors.push(
        `Image file too large: ${(imageStats.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`
      );
    }
    const imageExt = path.extname(imagePath).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(imageExt)) {
      errors.push(
        `Invalid image format: ${imageExt}. Accepted: png, jpg, jpeg, webp`
      );
    }
  } catch {
    errors.push("Image file not accessible");
  }

  if (maxDuration > MAX_VIDEO_DURATION) {
    errors.push(
      `Requested duration ${maxDuration}s exceeds maximum ${MAX_VIDEO_DURATION}s`
    );
  }

  return { valid: errors.length === 0, errors };
}
