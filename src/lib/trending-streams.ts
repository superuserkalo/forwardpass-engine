import { load } from "cheerio/slim";
import { z } from "zod";
import { githubOrgRepos, githubRisingRepos, huggingFaceOrgModels } from "./discovery-streams.js";
import type { Attention, Candidate } from "./schemas.js";

// Artifact-level streams that publisher feeds cannot cover: models, papers and
// repositories surface here first, with the traction a reader sees in the issue.
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type TrendingHealth = { stream: string; status: "ok" | "failed"; items: number; error?: string };

const hfModel = z.object({ id: z.string(), likes: z.number().default(0), downloads: z.number().default(0), trendingScore: z.number().default(0),
  createdAt: z.string().optional(), lastModified: z.string().optional(), pipeline_tag: z.string().optional(), tags: z.array(z.string()).default([]) });
const hfPaper = z.object({ paper: z.object({ id: z.string(), title: z.string(), summary: z.string().default(""), upvotes: z.number().default(0), publishedAt: z.string().optional() }),
  numComments: z.number().default(0) });

function metric(platform: Attention["platform"], id: string, url: string, measuredAt: string, score: number, secondaryCount: number, perDay?: number): Attention {
  return { platform, id, url, measuredAt, score, secondaryCount, previousMeasuredAt: null, elapsedHours: perDay === undefined ? null : 24,
    scoreDelta: perDay ?? null, scorePerHour: perDay === undefined ? null : perDay / 24, secondaryDelta: null };
}

async function json(fetcher: Fetcher, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { "User-Agent": "ForwardPassSourceCollector/1.0", ...(process.env.HF_TOKEN && url.includes("huggingface.co") ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  return response.json();
}

export async function huggingFaceTrendingModels(fetcher: Fetcher, now: Date, limit = 60): Promise<Candidate[]> {
  const at = now.toISOString();
  const rows = z.array(hfModel).parse(await json(fetcher, `https://huggingface.co/api/models?sort=trendingScore&limit=${limit}&expand[]=likes&expand[]=downloads&expand[]=trendingScore&expand[]=createdAt&expand[]=lastModified&expand[]=pipeline_tag&expand[]=tags`));
  return rows.map((model) => {
    const url = `https://huggingface.co/${model.id}`;
    const license = model.tags.find((tag) => tag.startsWith("license:"))?.slice(8);
    return { title: `${model.id}${model.pipeline_tag ? ` (${model.pipeline_tag})` : ""}`,
      summary: `Trending Hugging Face model: ${model.likes.toLocaleString("en-US")} likes, ${model.downloads.toLocaleString("en-US")} downloads (30 days)${license ? `, license ${license}` : ""}.`,
      url, publishedAt: model.createdAt ?? null, dateKind: "first-seen", firstSeenAt: at, observedAt: at,
      source: "Hugging Face trending", category: "trending model",
      attention: [metric("huggingface", model.id, url, at, model.likes, model.downloads)] };
  });
}

export async function huggingFaceDailyPapers(fetcher: Fetcher, now: Date): Promise<Candidate[]> {
  const at = now.toISOString();
  // Without a date the API returns its latest published day; a date past that is rejected.
  const rows = z.array(hfPaper).parse(await json(fetcher, "https://huggingface.co/api/daily_papers?limit=50"));
  return rows.map(({ paper, numComments }) => {
    const url = `https://huggingface.co/papers/${paper.id}`;
    return { title: paper.title, summary: paper.summary.slice(0, 1200), url, publishedAt: paper.publishedAt ?? null,
      dateKind: "first-seen", firstSeenAt: at, observedAt: at, source: "Hugging Face daily papers", category: "research",
      attention: [metric("huggingface", `paper:${paper.id}`, url, at, paper.upvotes, numComments)] };
  });
}

// GitHub has no trending API; the public page lists daily star gains.
export function parseGithubTrending(html: string, measuredAt: string): Candidate[] {
  const $ = load(html);
  return $("article.Box-row").toArray().flatMap((row) => {
    const href = $(row).find("h2 a").attr("href")?.trim();
    if (!href || !/^\/[\w.-]+\/[\w.-]+$/.test(href)) return [];
    const repo = href.slice(1);
    const number = (text: string) => Number(text.replace(/[^\d]/g, "")) || 0;
    const stars = number($(row).find(`a[href="${href}/stargazers"]`).text());
    const forks = number($(row).find(`a[href="${href}/forks"]`).text());
    const today = number($(row).find("span").toArray().map((span) => $(span).text()).find((text) => /stars today/.test(text)) ?? "");
    const description = $(row).find("p").first().text().trim().replace(/\s+/g, " ");
    const url = `https://github.com/${repo}`;
    return [{ title: repo, summary: `${description ? `${description} ` : ""}(${today.toLocaleString("en-US")} stars today, ${stars.toLocaleString("en-US")} total)`.trim(),
      url, publishedAt: null, dateKind: "first-seen" as const, firstSeenAt: measuredAt, observedAt: measuredAt,
      source: "GitHub trending", category: "trending repository",
      attention: [metric("github", repo.toLowerCase(), url, measuredAt, stars, forks, today)] }];
  });
}

export async function githubTrending(fetcher: Fetcher, now: Date): Promise<Candidate[]> {
  const response = await fetcher("https://github.com/trending?since=daily", { headers: { "User-Agent": "Mozilla/5.0 ForwardPassSourceCollector/1.0" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  return parseGithubTrending(await response.text(), now.toISOString());
}

export async function collectTrending(options: { now?: Date; fetcher?: Fetcher; githubToken?: string } = {}): Promise<{ items: Candidate[]; health: TrendingHealth[] }> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const token = options.githubToken ?? process.env.GITHUB_TOKEN;
  // The last two ask the source directly for what trending lists find late: a lab's new models and new AI repositories.
  const streams = { "huggingface-trending-models": huggingFaceTrendingModels, "huggingface-daily-papers": huggingFaceDailyPapers, "github-trending": githubTrending,
    "huggingface-org-models": huggingFaceOrgModels, "github-org-repos": (f: Fetcher, n: Date) => githubOrgRepos(f, n, token), "github-rising-repos": (f: Fetcher, n: Date) => githubRisingRepos(f, n, token) };
  const settled = await Promise.all(Object.entries(streams).map(async ([stream, run]) => {
    try { const items = await run(fetcher, now); return { items, health: { stream, status: "ok" as const, items: items.length } }; }
    catch (error) { return { items: [], health: { stream, status: "failed" as const, items: 0, error: error instanceof Error ? error.message : String(error) } }; }
  }));
  return { items: settled.flatMap(({ items }) => items), health: settled.map(({ health }) => health) };
}
