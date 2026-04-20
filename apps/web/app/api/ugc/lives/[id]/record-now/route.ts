// Client-side loop endpoint: grava 1 chunk (ou finaliza) por chamada.
// Usado quando o usuário abre a página e dispara gravação ao vivo.
// Em paralelo, /api/cron/record-lives roda a cada 2min garantindo que
// a gravação continue mesmo com a aba fechada.
//
// Self-chain: quando um chunk termina e a live ainda está ativa, usamos
// `after()` pra disparar a próxima chamada em background (com CRON_SECRET),
// sem esperar resposta. Isso mantém gravação contínua mesmo se o usuário
// fechar a aba — o servidor continua encadeando chunks sozinho até a live
// acabar. Cron de 2min continua como fallback caso o chain quebre.

import { NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@motion/database";
import { recordChunk, finalizeRecording } from "@/lib/ugc/live-recorder";
import { confirmLiveEnded } from "@/lib/ugc/live-scraper";

export const maxDuration = 300;
export const runtime = "nodejs";

interface Body {
  durationSeconds?: number;
  finalize?: boolean;
  chained?: boolean;
  restart?: boolean;
  confirmFirst?: boolean;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Autenticação dupla: sessão do usuário OU CRON_SECRET Bearer (pro self-chain).
  const authHeader = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const isChainCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  let userId: string | null = null;
  if (!isChainCall) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    userId = session.user.id;
  }

  const { id } = await params;
  const body = ((await req.json().catch(() => ({}))) as Body) || {};

  const live = await prisma.liveSession.findUnique({ where: { id } });
  if (!live) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (userId && live.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.finalize) {
    // confirmFirst: chain dispara finalize via HTTP e pede verificação dupla.
    // Se TikTok volta pra status=2 (flap), retorna sem finalizar — deixa
    // chain/cron continuarem gravando. User clicando Parar NÃO usa isso
    // (finalize imediato).
    if (body.confirmFirst && isChainCall && live.roomId) {
      const ended = await confirmLiveEnded(live.roomId);
      if (!ended) {
        // Dispara novo chain pra voltar a gravar.
        if (cronSecret) {
          const baseUrl =
            process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
          after(async () => {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            try {
              await fetch(`${baseUrl}/api/ugc/lives/${id}/record-now`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  authorization: `Bearer ${cronSecret}`,
                },
                body: JSON.stringify({ chained: true }),
                signal: controller.signal,
              });
            } catch {
              /* abort esperado */
            } finally {
              clearTimeout(t);
            }
          });
        }
        return NextResponse.json({ ok: true, action: "flap_recovered" });
      }
    }
    let result = await finalizeRecording(id);
    // Se outro finalize (chain/cron) já está rodando, espera e verifica.
    // Até 60s total. Se concluiu, retorna sucesso; senão, avisa cliente.
    if (!result.ok && result.error === "finalize_locked") {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await prisma.liveSession.findUnique({
          where: { id },
          select: { recordingStatus: true },
        });
        if (check?.recordingStatus === "DONE" || check?.recordingStatus === "FAILED") {
          result = await finalizeRecording(id);
          break;
        }
      }
    }
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: "message" in result ? result.message : undefined },
        { status: 400 },
      );
    }
    const { updated } = result;
    return NextResponse.json({
      success: true,
      finalUrl: result.finalUrl,
      chunks: result.chunks,
      session: {
        ...updated,
        likeCount: Number(updated.likeCount),
        totalViewers: Number(updated.totalViewers),
      },
    });
  }

  // Reset SÓ quando cliente pediu explicitamente (restart: true), ou seja,
  // user clicou Gravar de novo numa session já finalizada. Chamadas normais
  // do loop (restart !== true) em session DONE retornam already_finalized
  // com stillLive=false pra loop parar sem destruir o recordingUrl salvo.
  //
  // Bug que isso resolve: chain/cron finaliza a session em paralelo, depois
  // o próximo /record-now do loop do cliente caía no reset e apagava a
  // gravação de X minutos, começando do zero.
  if (!isChainCall && body.restart && (live.recordingStatus === "DONE" || live.recordingStatus === "FAILED")) {
    await prisma.liveSession.update({
      where: { id },
      data: {
        recordingStatus: "NONE",
        recordingUrl: null,
        recordingError: null,
        recordingStartedAt: null,
        recordingEndedAt: null,
        recordingDurationSeconds: null,
        recordingLockedUntil: null,
      },
    });
  } else if (!isChainCall && !body.restart && live.recordingStatus === "DONE") {
    // Loop do cliente: live já foi finalizada (chain/cron). Sai limpo.
    return NextResponse.json(
      { error: "already_finalized", stillLive: false, finalUrl: live.recordingUrl },
      { status: 409 },
    );
  }

  // Chamada chaineada (server-side) usa chunks longos (250s) pra maximizar
  // throughput. Chamada do cliente continua curta (45s default) pra feedback
  // rápido da UI.
  const defaultDuration = isChainCall ? 250 : 45;
  const result = await recordChunk(id, body.durationSeconds ?? defaultDuration);

  // Self-chain: só chameia quando chamada veio do chain/cron. Cliente dirige
  // o próprio loop (chunks curtos pra feedback UI). Quando o cliente fecha
  // aba, o cron (2min) pega e inicia o chain a partir daí — chain se
  // autoperpetua até a live acabar ou outro chunk pegar o lock.
  //
  // Fire-and-forget: abort após 3s pra não bloquear a função atual pelos
  // 250s do próximo chunk.
  if (isChainCall && result.ok && result.stillLive && cronSecret) {
    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    after(async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${baseUrl}/api/ugc/lives/${id}/record-now`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${cronSecret}`,
          },
          body: JSON.stringify({ chained: true }),
          signal: controller.signal,
        });
      } catch {
        // AbortError esperado — a nova invocação já está rodando no servidor.
      } finally {
        clearTimeout(t);
      }
    });
  }

  // Se live caiu durante o chunk e esta foi chamada chaineada, dispara
  // finalize em invocação SEPARADA (fire-and-forget HTTP) com confirmFirst.
  // Evita que confirmLiveEnded (22s) + concat (30s+) extrapolem os 300s
  // da função atual, que já gastou até 250s no chunk.
  if (result.ok && !result.stillLive && isChainCall && cronSecret && live.roomId) {
    const baseUrl =
      process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    after(async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${baseUrl}/api/ugc/lives/${id}/record-now`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${cronSecret}`,
          },
          body: JSON.stringify({ finalize: true, confirmFirst: true }),
          signal: controller.signal,
        });
      } catch {
        /* abort esperado */
      } finally {
        clearTimeout(t);
      }
    });
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message, stillLive: result.stillLive },
      { status: result.error === "no_stream_url" ? 400 : 500 },
    );
  }

  return NextResponse.json({
    success: true,
    chunkUrl: result.chunkUrl,
    chunkSeconds: result.chunkSeconds,
    cumulativeSeconds: result.cumulativeSeconds,
    stillLive: result.stillLive,
  });
}
