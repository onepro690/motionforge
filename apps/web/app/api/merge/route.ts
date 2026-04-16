import { NextResponse } from "next/server";

/**
 * Video merge endpoint.
 * ffmpeg-based merging requires a persistent server (not serverless).
 * Returns 503 in all environments — multi-take page handles this gracefully
 * by showing individual video downloads instead.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "merge_unavailable",
      message: "A mesclagem automática não está disponível. Baixe os vídeos individuais de cada take.",
    },
    { status: 503 }
  );
}
