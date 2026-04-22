"use client";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  name: string;
  imageUrl: string;
  className?: string;
  imgClassName?: string;
}

export function CharacterAvatar({ name, imageUrl, className, imgClassName }: Props) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const initial = (name?.[0] ?? "?").toUpperCase();

  return (
    <div className={cn("relative w-full h-full bg-white/5 overflow-hidden", className)}>
      <div className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/25 select-none">
        {initial}
      </div>
      {!errored && (
        <img
          src={imageUrl}
          alt={name}
          loading="eager"
          decoding="async"
          crossOrigin="anonymous"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className={cn(
            "relative w-full h-full object-cover transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
        />
      )}
    </div>
  );
}
