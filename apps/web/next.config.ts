import type { NextConfig } from "next";

const productionHost = process.env.NEXT_PUBLIC_APP_URL
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/^https?:\/\//, "")
  : null;

const nextConfig: NextConfig = {
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
  async rewrites() {
    return [
      {
        source: "/api/uploads/:path*",
        destination: "/api/serve-upload/:path*",
      },
    ];
  },
};

export default nextConfig;
