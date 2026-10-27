import { z } from "zod";
import { attentionSchema, candidateSchema, type Attention, type Candidate } from "./schemas.js";
import { SOURCE_STREAMS, type SourceStream } from "./source-streams.js";

export const attentionReportSchema = z.object({
  measuredAt: z.string(), measurements: z.array(attentionSchema), candidates: z.array(candidateSchema),
  health: z.array(z.object({ platform: z.string(), status: z.enum(["ok", "partial", "failed"]), attempted: z.number(), measured: z.number(), error: z.string().optional() })),
});
export type AttentionReport = z.infer<typeof attentionReportSchema>;

export function measureAttention(current: Omit<Attention, "previousMeasuredAt" | "elapsedHours" | "scoreDelta" | "scorePerHour" | "secondaryDelta">, previous?: Attention): Attention {
  const hours = previous ? (Date.parse(current.measuredAt) - Date.parse(previous.measuredAt)) / 3_600_000 : 0;
  const usable = previous && previous.platform === current.platform && previous.id === current.id && hours > 0;
  const delta = usable ? current.score - previous.score : null;
  return { ...current, previousMeasuredAt: usable ? previous.measuredAt : null, elapsedHours: usable ? hours : null,
    scoreDelta: delta, scorePerHour: delta === null ? null : delta / hours,
    secondaryDelta: usable ? current.secondaryCount - previous.secondaryCount : null };
}

export function githubRepository(value: string): string | null {
  try {
    const u = new URL(value);
    const parts = u.pathname.split("/").filter(Boolean);
    const pair = u.hostname === "api.github.com" && parts[0] === "repos" ? parts.slice(1, 3)
      : ["github.com", "raw.githubusercontent.com"].includes(u.hostname) ? parts.slice(0, 2) : [];
    if (pair.length !== 2 || ["topics", "orgs", "settings", "search", "features", "collections", "sponsors", "trending", "marketplace"].includes(pair[0]) || !pair.every((s) => /^[\w.-]+$/.test(s))) return null;
    return pair.join("/").replace(/\.git$/, "").toLowerCase();
  } catch { return null; }
}

export function attachAttention(candidates: Candidate[], measurements: Attention[]): Candidate[] {
  const byUrl = new Map<string, Attention[]>();
  const canonical = (value: string) => { const u = new URL(value); u.hash = ""; for (const k of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/.test(k)) u.searchParams.delete(k); u.searchParams.sort(); return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`; };
  for (const metric of measurements) {
    const key = metric.platform === "github" ? `repo:${metric.id.toLowerCase()}` : canonical(metric.url);
    byUrl.set(key, [...(byUrl.get(key) ?? []), metric]);
  }
  return candidates.map((candidate) => {
    const repo = githubRepository(candidate.url);
    let measured: Attention[];
    try { measured = [...(byUrl.get(canonical(candidate.url)) ?? []), ...(repo ? byUrl.get(`repo:${repo}`) ?? [] : [])]; } catch { measured = []; }
    // Stream-supplied traction (Hugging Face likes, GitHub stars today) survives; fresher samples replace same-ID ones.
    const own = (candidate.attention ?? []).filter((m) => !measured.some((n) => n.platform === m.platform && n.id === m.id));
    return { ...candidate, attention: [...own, ...measured] };
  });
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

// Algolia returns at most 1,000 hits per query, so the last two days are read in 8-hour
// windows. One request per window replaces ~1,000 per-item Firebase requests.
const hnHit = z.object({
  objectID: z.string(), title: z.string().nullish(), url: z.string().nullish(),
  points: z.number().nullish(), num_comments: z.number().nullish(), created_at_i: z.number(),
});
const HN_WINDOW_HOURS = 8;
const HN_LOOKBACK_HOURS = 48;
const HN_MIN_POINTS = 3;

async function hackerNews(fetcher: Fetcher, now: Date, measuredAt: string, prior: Map<string, Attention>) {
  const measurements: Attention[] = [];
  const candidates: Candidate[] = [];
  let failed = 0, attempted = 0;
  const end = Math.floor(now.getTime() / 1000);
  for (let from = end - HN_LOOKBACK_HOURS * 3600; from < end; from += HN_WINDOW_HOURS * 3600) {
    attempted++;
    const to = Math.min(end, from + HN_WINDOW_HOURS * 3600);
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000&numericFilters=${encodeURIComponent(`created_at_i>=${from},created_at_i<${to},points>=${HN_MIN_POINTS}`)}`;
    try {
      const response = await fetcher(url, { headers: { "User-Agent": "ForwardPassSourceCollector/1.0" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const hits = z.object({ hits: z.array(hnHit) }).parse(await response.json()).hits;
      for (const hit of hits) {
        if (!hit.title) continue;
        const link = hit.url?.startsWith("https://") ? hit.url : `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const metric = measureAttention({ platform: "hacker-news", id: hit.objectID, url: link, measuredAt, score: hit.points ?? 0, secondaryCount: hit.num_comments ?? 0 }, prior.get(`hacker-news:${hit.objectID}`));
        measurements.push(metric);
        candidates.push({ title: hit.title, summary: "Hacker News submission; attention is an interest signal, not independent verification.", url: link,
          publishedAt: null, observedAt: measuredAt, firstSeenAt: measuredAt, submittedAt: new Date(hit.created_at_i * 1000).toISOString(),
          dateKind: "first-seen", source: "Hacker News", category: "community signal", attention: [metric] });
      }
    } catch { failed++; }
  }
  return { measurements, candidates, health: { platform: "hacker-news", status: failed ? (measurements.length ? "partial" as const : "failed" as const) : "ok" as const, attempted, measured: measurements.length, ...(failed ? { error: `${failed} of ${attempted} windows failed` } : {}) } };
}

// GitHub GraphQL reads stars for 50 repositories per request instead of one REST call each.
const GITHUB_BATCH = 50;
const repoNode = z.object({ nameWithOwner: z.string(), url: z.string(), stargazerCount: z.number(), forkCount: z.number() }).nullable();

async function githubStars(fetcher: Fetcher, repos: string[], measuredAt: string, prior: Map<string, Attention>, token: string | undefined) {
  const measurements: Attention[] = [];
  if (!token) return { measurements, health: { platform: "github", status: "failed" as const, attempted: 0, measured: 0, error: "GITHUB_TOKEN is not configured" } };
  let failed = 0, attempted = 0;
  for (let start = 0; start < repos.length; start += GITHUB_BATCH) {
    const batch = repos.slice(start, start + GITHUB_BATCH);
    attempted++;
    const fields = batch.map((repo, i) => {
      const [owner, name] = repo.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner url stargazerCount forkCount }`;
    }).join("\n");
    try {
      const response = await fetcher("https://api.github.com/graphql", {
        method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "ForwardPassSourceCollector/1.0" },
        body: JSON.stringify({ query: `query {\n${fields}\n}` }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const data = z.object({ data: z.record(z.string(), repoNode).nullable() }).parse(await response.json()).data ?? {};
      batch.forEach((repo, i) => {
        const node = data[`r${i}`];
        if (!node) return;
        measurements.push(measureAttention({ platform: "github", id: repo, url: node.url, measuredAt, score: node.stargazerCount, secondaryCount: node.forkCount }, prior.get(`github:${repo}`)));
      });
    } catch { failed++; }
  }
  return { measurements, health: { platform: "github", status: failed ? (measurements.length ? "partial" as const : "failed" as const) : "ok" as const, attempted, measured: measurements.length, ...(failed ? { error: `${failed} of ${attempted} batches failed` } : {}) } };
}

export async function collectAttention(candidates: Candidate[], previous?: AttentionReport, options: { now?: Date; fetcher?: Fetcher; streams?: readonly SourceStream[]; githubToken?: string } = {}): Promise<AttentionReport> {
  const now = options.now ?? new Date();
  const measuredAt = now.toISOString();
  const fetcher = options.fetcher ?? fetch;
  const prior = new Map(previous?.measurements.map((m) => [`${m.platform}:${m.id}`, m]) ?? []);
  const hn = await hackerNews(fetcher, now, measuredAt, prior);
  const repos = [...new Set([...candidates.map((c) => c.url), ...(options.streams ?? SOURCE_STREAMS).filter((s) => !s.access || s.access === "public").map((s) => s.url)]
    .flatMap((url) => { const repo = githubRepository(url); return repo ? [repo] : []; }))].sort();
  const github = await githubStars(fetcher, repos, measuredAt, prior, options.githubToken ?? process.env.GITHUB_TOKEN);
  const measurements = [...hn.measurements, ...github.measurements];
  // Keep the last successful sample across transient failures, timestamped at its real observation time.
  const measured = new Set(measurements.map((m) => `${m.platform}:${m.id}`));
  const cutoff = now.getTime() - HN_LOOKBACK_HOURS * 3_600_000;
  for (const old of previous?.measurements ?? []) {
    const key = `${old.platform}:${old.id}`;
    if (measured.has(key)) continue;
    if (old.platform === "github" ? repos.includes(old.id) : old.platform === "hacker-news" && Date.parse(old.measuredAt) >= cutoff) measurements.push(old);
  }
  return { measuredAt, measurements, candidates: hn.candidates, health: [hn.health, github.health] };
}
