// Helper pro client envolver URLs de TikTok CDN no nosso proxy.
// TikTok bloqueia hotlinking com Referer check — sem proxy o <img> dá 403.

const PROXY_HOSTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tiktokv.com",
  "byteoversea.com",
  "bytedance.com",
];

export function proxyImage(url: string | null | undefined): string {
  if (!url || typeof url !== "string" || url.trim() === "") return "";
  try {
    const parsed = new URL(url);
    const needsProxy = PROXY_HOSTS.some(
      (h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`)
    );
    if (!needsProxy) return url;
    return `/api/ugc/image-proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

// onError: se o proxy falhar (CDN expirou), tenta a URL direta como último recurso.
export function handleImageError(originalUrl: string | null | undefined) {
  return (e: { currentTarget: HTMLImageElement }) => {
    const img = e.currentTarget;
    if (!originalUrl || img.src === originalUrl) return;
    img.src = originalUrl;
  };
}
