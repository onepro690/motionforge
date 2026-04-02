import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { path: pathParts } = await params;
  const storagePath = process.env.STORAGE_LOCAL_PATH ?? "./uploads";

  const filePath = path.join(process.cwd(), storagePath, ...pathParts);

  // Security: ensure path is within uploads directory
  const uploadsDir = path.resolve(process.cwd(), storagePath);
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(uploadsDir)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (!fs.existsSync(filePath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const contentType = mimeTypes[ext] ?? "application/octet-stream";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
