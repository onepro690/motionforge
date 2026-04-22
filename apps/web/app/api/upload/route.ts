import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const fileType = clientPayload ?? "input_image";
        const isVideo = fileType === "input_video";

        return {
          // For videos, restrict to known types. For images, allow any format (HEIC, AVIF, etc.)
          allowedContentTypes: isVideo ? ALLOWED_VIDEO_TYPES : undefined,
          maximumSizeInBytes: isVideo
            ? 2 * 1024 * 1024 * 1024  // 2GB for video
            : 50 * 1024 * 1024,       // 50MB for image
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: session.user.id, fileType }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const { userId, fileType } = JSON.parse(tokenPayload ?? "{}") as {
          userId?: string;
          fileType?: string;
        };
        if (!userId) return;

        await prisma.asset.create({
          data: {
            userId,
            type: fileType ?? "input_image",
            url: blob.url,
            mimeType: blob.contentType ?? "application/octet-stream",
            size: 0,
          },
        });
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 }
    );
  }
}
