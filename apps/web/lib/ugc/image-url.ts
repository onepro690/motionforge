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
  if (!url) return "";
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
