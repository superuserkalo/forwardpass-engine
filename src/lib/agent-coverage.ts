import { z } from "zod";
import { archiveWindowStart, publishedDates } from "./archive.js";
import { storySlug } from "./cover-images.js";
import { editionStories } from "./edition-stories.js";
import { FEED_TOPICS, loadIssue, publishedMarkerSchema, type StoryRecord } from "./issue.js";
import { readPrivateJson } from "./private-store.js";
import { mapOrigins } from "./concurrency.js";
import type { AgentPlan } from "./agent-credits.js";

export const coverageQuerySchema = z.object({
  query: z.string().trim().max(500).optional(),
  topic: z.enum(FEED_TOPICS).optional(),
  since: z.iso.datetime({ offset: true }).describe("Last consumed edition publication time. Use the first page's updated_at after processing all pages, not checked_at or the current clock.").optional(),
  before: z.iso.date().optional(),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(1000).default(0),
});
export type CoverageQuery = z.infer<typeof coverageQuerySchema>;
export const agentStoryIdSchema = z.string().regex(/^daily:\d{4}-\d{2}-\d{2}:(?:s-[a-f0-9]{16}|\d{1,3}|signal:\d{1,3})$/);

const coverageStorySchema = z.object({
  id: z.string(), headline: z.string(), summary: z.string(), body: z.string().nullable(), topics: z.array(z.string()),
  source_url: z.string().nullable(), sources: z.array(z.object({ label: z.string(), url: z.string() })),
  source_published_at: z.string().nullable(), edition_published_at: z.string(), url: z.string(),
});
type CoverageStory = z.infer<typeof coverageStorySchema>;
const site = () => process.env.PUBLIC_SITE_URL ?? "https://theforwardpass.net";
const summary = (body: string | null) => (body ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim().slice(0, 400);

function record(date: string, at: string, story: StoryRecord): CoverageStory {
  return {
    id: `daily:${date}:${story.id}`, headline: story.headline, summary: summary(story.body), body: story.body,
    topics: story.topics, source_url: story.url, sources: story.sources,
    source_published_at: story.publishedAt, edition_published_at: at,
    url: story.role === "signal" ? story.url : `${site()}/archive/daily/${date}/${storySlug(story.headline)}`,
  };
}

async function edition(date: string, now: Date, cache?: Cache): Promise<CoverageStory[]> {
  const cacheKey = new Request(new URL(`/internal/agent-edition/${date}`, site()));
  const cached = await cache?.match(cacheKey);
  if (cached) {
    const parsed = z.array(coverageStorySchema).safeParse(await cached.json());
    if (parsed.success) return parsed.data.filter((story) => Date.parse(story.edition_published_at) <= now.getTime());
  }
  const marker = await readPrivateJson(`published/daily/${date}.json`);
  if (!marker) return [];
  const parsed = publishedMarkerSchema.safeParse(marker);
  const at = parsed.success ? parsed.data.publishedAt : `${date}T07:00:00Z`;
  if (Date.parse(at) > now.getTime()) return [];
  const issue = await loadIssue(date);
  if (!issue) return [];
  const stories = issue.version === 2 ? issue.stories.map((story) => record(date, at, story)) : editionStories(issue.markdown).map((story) => ({
    id: `daily:${date}:${story.kind === "signal" ? "signal:" : ""}${story.index}`,
    headline: story.title, summary: story.dek, body: null, topics: [], source_url: story.sourceUrl,
    sources: story.sourceUrl ? [{ label: story.sourceLabel ?? "Source", url: story.sourceUrl }] : [],
    source_published_at: null, edition_published_at: at,
    url: `${site()}/archive/daily/${date}/${storySlug(story.title)}`,
  }));
  if (cache) await cache.put(cacheKey, Response.json(stories, { headers: { "Cache-Control": "max-age=300" } }));
  return stories;
}

async function coverageDates(cache?: Cache): Promise<string[]> {
  const key = new Request(new URL("/internal/agent-dates", site()));
  const cached = await cache?.match(key);
  if (cached) {
    const parsed = z.array(z.iso.date()).safeParse(await cached.json());
    if (parsed.success) return parsed.data;
  }
  const dates = await publishedDates("daily");
  if (cache) await cache.put(key, Response.json(dates, { headers: { "Cache-Control": "max-age=300" } }));
  return dates;
}

const ignoredTerms = new Set("a an the and or to of for in on with i we my our your what how is are that this build building use using interested interest interests work working want follow keep latest new news updates ai".split(" "));
function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]{1,}/gu) ?? []).map((word) => word.replace(/[.-]+$/, "")).filter((word) => !ignoredTerms.has(word)))];
}

/** Bounded scan of published editions. No model, source fetch, or reader-private material. */
export async function queryCoverage(input: CoverageQuery, interests = "", now = new Date(), cache?: Cache, plan: AgentPlan = "professional") {
  const earliest = archiveWindowStart(plan, now);
  const dates = (await coverageDates(cache)).filter((date) => date >= earliest && date <= now.toISOString().slice(0, 10) && (!input.before || date < input.before));
  const scanned = dates.slice(0, 31);
  const searchTerms = terms(input.query ?? interests);
  const stories = (await mapOrigins(scanned, () => "r2", (date) => edition(date, now, cache), 4, 4)).flat();
  const latest = stories.reduce<string | null>((at, story) => !at || story.edition_published_at > at ? story.edition_published_at : at, null);
  const seen = new Set<string>();
  const matches = stories.map((story) => {
    const haystack = `${story.headline} ${story.body ?? story.summary} ${story.topics.join(" ")}`.toLowerCase();
    const words = new Set(terms(haystack));
    const score = searchTerms.filter((term) => words.has(term)).length;
    return { story, score };
  }).filter(({ story, score }) => {
    if (input.since && Date.parse(story.edition_published_at) <= Date.parse(input.since)) return false;
    if (input.topic && !story.topics.includes(input.topic)) return false;
    if (searchTerms.length && score === 0) return false;
    const key = story.source_url ?? story.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.score - a.score || b.story.edition_published_at.localeCompare(a.story.edition_published_at));
  return {
    updated_at: latest, checked_at: now.toISOString(),
    coverage: "Published daily editions. Search matches keywords, not semantic meaning. Source publication dates may be unknown.",
    scanned_editions: scanned.length,
    next_before: dates.length > scanned.length ? scanned.at(-1) : null,
    next_offset: matches.length > input.offset + input.limit ? input.offset + input.limit : null,
    stories: matches.slice(input.offset, input.offset + input.limit).map(({ story }) => {
      const { body, ...fields } = story;
      return fields;
    }),
  };
}

export async function getCoverageStory(id: string, now = new Date(), cache?: Cache, plan: AgentPlan = "professional") {
  const parsed = agentStoryIdSchema.safeParse(id);
  if (!parsed.success) return null;
  const date = parsed.data.split(":")[1];
  if (!z.iso.date().safeParse(date).success || date < archiveWindowStart(plan, now)) return null;
  const story = (await edition(date, now, cache)).find((item) => item.id === id);
  return story ? { ...story, body: story.body?.slice(0, 20_000) ?? null, body_truncated: (story.body?.length ?? 0) > 20_000 } : null;
}
