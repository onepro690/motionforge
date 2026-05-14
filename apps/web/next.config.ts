import type { NextConfig } from "next";

const productionHost = process.env.NEXT_PUBLIC_APP_URL
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/^https?:\/\//, "")
  : null;

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "replicate",
    "@prisma/client",
    "prisma",
    "bcryptjs",
    "@motion/ai-providers",
    "@motion/storage",
    "@motion/queue",
    "@motion/database",
    "@anthropic-ai/sdk",
    "fluent-ffmpeg",
    "@ffmpeg-installer/ffmpeg",
    "ffmpeg-static",
    "google-auth-library",
    "tiktok-live-connector",
  ],
  experimental: {
    serverActions: {
      allowedOrigins: [
        "localhost:3000",
        ...(productionHost ? [productionHost] : []),
      ],
    },
  },
  // Garante que a fonte do narrator e o binário ffmpeg-static (necessário pro
  // filtro xfade) vão pro bundle serverless. Next 15 trace não inclui assets
  // binários por default.
  outputFileTracingIncludes: {
    "/api/narrator/**": [
      "./lib/narrator/fonts/**",
      "../../node_modules/ffmpeg-static/**",
    ],
    "/api/captions/**": [
      "./lib/narrator/fonts/**",
      "../../node_modules/ffmpeg-static/**",
    ],
  },
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
