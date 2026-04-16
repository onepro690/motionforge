import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "HEYGEN_API_KEY não configurada" }, { status: 500 });

  const { session_id } = await req.json();
  if (!session_id) return NextResponse.json({ error: "session_id obrigatório" }, { status: 400 });

  const res = await fetch("https://api.liveavatar.com/v1/sessions/keep-alive", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id }),
  });

  return NextResponse.json({ ok: res.ok, status: res.status });
}
