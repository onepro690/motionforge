import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "HEYGEN_API_KEY não configurada" }, { status: 500 });
  }

  const res = await fetch("https://api.heygen.com/v1/streaming.create_token", {
    method: "POST",
    headers: { "x-api-key": apiKey },
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `HeyGen error: ${text}` }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json({ token: data.data.token });
}
