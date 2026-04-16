import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "SIMLI_API_KEY não configurada" }, { status: 500 });

  const { faceId } = await req.json();

  const res = await fetch("https://api.simli.ai/compose/token", {
    method: "POST",
    headers: {
      "x-simli-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      faceId: faceId ?? "5514e24d-6086-46a3-ace4-6a7264e5cb7c",
      handleSilence: true,
      maxSessionLength: 600,
      maxIdleTime: 180,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.session_token === "FAIL TOKEN") {
    return NextResponse.json({ error: data.detail ?? "Falha ao criar token Simli" }, { status: 400 });
  }

  return NextResponse.json({ session_token: data.session_token });
}
