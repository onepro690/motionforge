import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MotionForge — AI Motion Transfer",
  description:
    "Gere vídeos com transferência de movimento usando IA. Aplique qualquer movimento em qualquer pessoa.",
  keywords: ["motion transfer", "AI video", "animation", "pose transfer"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className="dark">
      <body className={inter.className}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
