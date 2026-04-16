import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "HEYGEN_API_KEY não configurada" }, { status: 500 });

  const { avatar_id } = await req.json();
  if (!avatar_id) return NextResponse.json({ error: "avatar_id obrigatório" }, { status: 400 });

  // 1. Criar session token
  const tokenRes = await fetch("https://api.liveavatar.com/v1/sessions/token", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_id, mode: "FULL" }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return NextResponse.json({ error: `token error: ${text}` }, { status: tokenRes.status });
  }

  const tokenData = await tokenRes.json();
  const sessionToken = tokenData.data?.session_token;
  const sessionId = tokenData.data?.session_id;

  // 2. Iniciar sessão
  const startRes = await fetch("https://api.liveavatar.com/v1/sessions/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
  });

  if (!startRes.ok) {
    const text = await startRes.text();
    return NextResponse.json({ error: `start error: ${text}` }, { status: startRes.status });
  }

  const startData = await startRes.json();

  return NextResponse.json({
    session_id: sessionId,
    livekit_url: startData.data?.livekit_url,
    livekit_client_token: startData.data?.livekit_client_token,
    max_session_duration: startData.data?.max_session_duration ?? 120,
  });
}
