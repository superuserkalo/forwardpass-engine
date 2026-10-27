// Publishers own a registrable domain; app/dashboard/demo subdomains rarely carry feeds.
// Shared hosting (github.io, vercel.app, …) stays per-site.
const SHARED_HOSTING = /\.(github\.io|vercel\.app|netlify\.app|pages\.dev|web\.app)$/;

export function publisherDomain(host: string): string {
  if (SHARED_HOSTING.test(host)) return host;
  const labels = host.split(".");
  const keep = labels.length >= 3 && /^(co|com|ac|org|net|gov|edu)$/.test(labels.at(-2)!) && labels.at(-1)!.length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}
