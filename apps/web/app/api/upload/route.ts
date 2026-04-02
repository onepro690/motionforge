import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import path from "path";
import { nanoid } from "nanoid";
import { put } from "@vercel/blob";

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
];
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const type = formData.get("type") as string | null;

    if (!file)
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    if (!type)
      return NextResponse.json(
        { error: "No file type provided" },
        { status: 400 }
      );

    const isVideo = type === "input_video";
    const isImage = type === "input_image";

    if (isVideo && !ALLOWED_VIDEO_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Invalid video type: ${file.type}` },
        { status: 400 }
      );
    }
    if (isImage && !ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Invalid image type: ${file.type}` },
        { status: 400 }
      );
    }

    const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File too large. Max: ${maxSize / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    const ext = path.extname(file.name) || (isVideo ? ".mp4" : ".jpg");
    const key = `uploads/${session.user.id}/${type}/${nanoid()}${ext}`;

    const blob = await put(key, file, { access: "public" });

    await prisma.asset.create({
      data: {
        userId: session.user.id,
        type,
        url: blob.url,
        mimeType: file.type,
        size: file.size,
      },
    });

    return NextResponse.json({ url: blob.url, key });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
