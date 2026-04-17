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
    "@ffprobe-installer/ffprobe",
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
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
