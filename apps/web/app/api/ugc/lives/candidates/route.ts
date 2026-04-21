import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { collectCandidatePool } from "@/lib/ugc/live-scraper";

export const maxDuration = 300;

// Discovery-only endpoint. Roda no Vercel e devolve handles candidatos
// pro worker local verificar (webcast.tiktok.com é WAF-blocked aqui).
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const result = await collectCandidatePool(userId);
  return NextResponse.json(result);
}
