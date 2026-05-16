// Helpers de concorrência / retry usados nos submits do Veo.
//
// Motivação: o modelo veo-3.0-fast-generate-001 tem cap nos requests
// long-running concorrentes por projeto. Disparar 10+ takes em paralelo
// estoura o erro "Quota exceeded for
// aiplatform.googleapis.com/long_running_online_prediction_requests_per_base_model".

const QUOTA_HINTS = [
  "Quota exceeded",
  "RESOURCE_EXHAUSTED",
  "429",
  "rate limit",
];

export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return QUOTA_HINTS.some((h) => msg.toLowerCase().includes(h.toLowerCase()));
}

// Pool de workers: processa items respeitando concurrency, retorna na ordem
// original. Cada item passa por `fn`. Se quiser captura de erro por item,
// use `settledPool` abaixo.
export async function pMapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Versão "allSettled-like": retorna PromiseSettledResult por item, sem nunca
// rejeitar o pool inteiro por causa de um item que falhou.
export async function settledPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return pMapLimit(items, concurrency, async (item, idx) => {
    try {
      const value = await fn(item, idx);
      return { status: "fulfilled", value } satisfies PromiseFulfilledResult<R>;
    } catch (err) {
      return { status: "rejected", reason: err } satisfies PromiseRejectedResult;
    }
  });
}

// Retry com backoff exponencial específico pra erros de quota. Outros
// erros propagam imediatamente (não retry).
export async function withQuotaRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 3000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isQuotaError(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Cap de concorrência usado em pontos pontuais (Promise.allSettled paralelo).
// Conservador (3) pra evitar estourar a quota long_running_online_prediction
// do Veo3 Fast. Mantido pra compat com generate em modos diferentes de
// 'conversation' que não usam scheduler.
export const VEO_SUBMIT_CONCURRENCY = 3;

// Quantos takes o /generate dispara imediatamente ao criar o job. Os outros
// ficam status='QUEUED' e são submetidos gradualmente pelo polling do
// /[id] conforme os ativos terminam — vira um scheduler natural respeitando
// a quota Vertex (que é por predictions concorrentes, não por requests/seg).
export const VEO_INITIAL_BURST = 3;

// Cap de takes simultâneos em PROCESSING. Polling do /[id] usa esse número
// pra decidir quantos QUEUED submeter por rodada. Igual ao BURST por simetria.
export const VEO_MAX_PARALLEL = 3;
