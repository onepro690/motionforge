# TikTok Verify Worker

Daemon local que roda no seu PC e verifica se lives do TikTok Shop estão ao vivo.

## Por que existe?

O TikTok bloqueia IPs da Vercel (WAF) quando chamamos `webcast.tiktok.com` —
o endpoint oficial que confirma `status=2` e tem flag `has_commerce_goods`.
Do seu PC (IP residencial), esses endpoints funcionam normalmente.

O servidor faz a descoberta (lista de candidatos) e este worker confirma
quais estão realmente ao vivo com produto do TikTok Shop.

## Como usar

1. Abra a pasta `worker/` no Explorer.
2. Dê duplo clique em `start.bat`.
3. Deixe a janela aberta enquanto usa "Buscar Lives" em motion-transfer-saas.vercel.app.

O site detecta automaticamente se o worker está rodando e usa ele. Se estiver
fechado, cai no caminho antigo (menos lives encontradas).

## Requisitos

- Windows (outros SOs: rode `node tiktok-verify.mjs` no terminal)
- Node.js 18+ — baixe em https://nodejs.org

## Endpoints

- `GET  http://localhost:3333/health` → `{ ok: true, version }`
- `POST http://localhost:3333/verify`
  - body: `{ candidates: [{handle, nickname?, avatarUrl?, roomId?}], concurrency?, gapMs? }`
  - resp: `{ lives: [...verified lives], stats: {...} }`

## Segurança

- Escuta só em `127.0.0.1` (localhost) — não é acessível pela rede.
- CORS limitado a `motion-transfer-saas.vercel.app` + localhost dev.
- Body cap 2MB. Sem deps (só Node.js built-in).
