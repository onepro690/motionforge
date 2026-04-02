# MotionForge — AI Motion Transfer SaaS

SaaS de geração de vídeo com transferência de movimento via IA. Permite que o usuário envie um vídeo de referência de movimento e uma foto de avatar, gerando um novo vídeo onde a pessoa da foto reproduz o movimento.

## Stack

- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- **Auth**: better-auth com PostgreSQL
- **Database**: PostgreSQL + Prisma ORM
- **Queue**: Redis + BullMQ
- **Storage**: Local (desenvolvimento) / S3-compatible (produção)
- **AI Providers**: Mock (dev), Replicate, ComfyUI (modulares)
- **Worker**: Node.js + TypeScript separado

## Requisitos

- Node.js 18+
- Docker + Docker Compose (para PostgreSQL e Redis)

## Instalação rápida

```bash
# 1. Instale dependências
cd motion-transfer-saas
npm install

# 2. Inicie PostgreSQL e Redis
docker-compose up -d

# 3. Configure banco de dados
cd packages/database
npm run db:push
npm run db:seed
cd ../..

# 4. Inicie o frontend
cd apps/web
npm run dev
# Acesse: http://localhost:3000

# 5. Em outro terminal, inicie o worker
cd apps/worker
npm run dev
```

## Usuário de Teste

- **Email**: `progerio690@gmail.com`
- **Senha**: `12345678`

## Variáveis de Ambiente

O arquivo `apps/web/.env.local` já vem preenchido para desenvolvimento local com Docker. Para customizar, edite esse arquivo ou o `.env.example` na raiz.

## AI Providers

| Provider | Como ativar |
|----------|-------------|
| `mock` | Padrão. Simula processamento localmente. |
| `replicate` | `AI_PROVIDER=replicate` + `REPLICATE_API_TOKEN=...` |
| `comfyui` | `AI_PROVIDER=comfyui` + `COMFYUI_URL=http://...` |

## Storage em Produção (S3/R2)

```env
STORAGE_TYPE="s3"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_REGION="us-east-1"
AWS_BUCKET_NAME="motion-transfer"
# Para Cloudflare R2:
AWS_ENDPOINT_URL="https://seu-account.r2.cloudflarestorage.com"
```

## Páginas

| Rota | Descrição |
|------|-----------|
| `/` | Landing page |
| `/login` | Login |
| `/register` | Cadastro |
| `/dashboard` | Dashboard principal |
| `/generate` | Criar nova geração |
| `/jobs/:id` | Detalhes do job |
| `/history` | Histórico de gerações |
| `/settings` | Configurações do perfil |

## API

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/auth/sign-in/email` | Login |
| POST | `/api/auth/sign-up/email` | Cadastro |
| POST | `/api/upload` | Upload de arquivo |
| GET | `/api/jobs` | Listar jobs |
| POST | `/api/jobs` | Criar job |
| GET | `/api/jobs/:id` | Buscar job |
| DELETE | `/api/jobs/:id` | Deletar job |
| POST | `/api/jobs/:id/retry` | Retry job falho |
| GET | `/api/health` | Health check |

## Deploy

### Frontend (Vercel)

```bash
npm install -g vercel
vercel login
cd apps/web
vercel
```

Adicione todas as env vars no painel da Vercel (DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, etc).

### Worker

O worker precisa rodar em um servidor separado (Railway, Render, Fly.io, EC2) com acesso ao mesmo PostgreSQL e Redis.

```bash
cd apps/worker
npm run build
npm start
```
