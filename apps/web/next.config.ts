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
  // Garante que a fonte do narrator vai pro bundle serverless (Next 15 trace
  // não inclui assets binários por default).
  outputFileTracingIncludes: {
    "/api/narrator/**": ["./lib/narrator/fonts/**"],
  },
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
