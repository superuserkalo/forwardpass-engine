import type { Resend } from "resend";
import { archiveIdentity, archiveWindowStart, publishedDates } from "./archive.js";
import { listArticles, loadArticle, type Article } from "./articles.js";
import { imageIds, imagePath, legacyStoryId, storySlug } from "./cover-images.js";
import { loadIssue, publishedMarkerSchema, type StoryRecord } from "./issue.js";
import { readPrivateJson } from "./private-store.js";
import { editionStories, type EditionStory } from "./edition-stories.js";
import { verifyPreferencesToken } from "./preference-link.js";
import { readerHash, voteTallies, type VoteTally } from "./reader-votes.js";

/** How many recent daily editions one feed request reads. Keeps each request to a bounded number of reads. */
const MAX_EDITIONS = 14;
/** Legacy editions without a recorded publication time went out at 07:00 UTC. */
const PUBLISH_HOUR = "T07:00:00Z";

export type FeedStoryType = "news" | "papers" | "models" | "repos" | "editorial";

export function readerEmail(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  return bearer ? verifyPreferencesToken(bearer) : null;
}

export function sourceName(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "github.com") {
      const owner = parsed.pathname.split("/").filter(Boolean)[0];
      if (owner) return owner.toUpperCase();
    }
    const labels = host.split(".");
    return (labels.length >= 2 ? labels[labels.length - 2] : labels[0]).replace(/[-_]/g, " ").toUpperCase();
  } catch {
    return null;
  }
}

export function storyType(title: string, url: string | null): FeedStoryType {
  const host = url ? url.toLowerCase() : "";
  const text = title.toLowerCase();
  if (host.includes("arxiv.org") || host.includes("huggingface.co/papers") || host.includes("openreview.net") || /\bpaper\b/.test(text)) return "papers";
  if (host.includes("github.com")) return "repos";
  if (/\b(model|weights|checkpoint)\b/.test(text) || /\breleased?\b/.test(text) || host.includes("huggingface.co/")) return "models";
  return "news";
}

function voteFields(tallies: Map<string, VoteTally>, id: string, viewer: string | null) {
  const tally = tallies.get(id);
  return { upvotes: tally?.count ?? 0, viewer_has_upvoted: viewer ? (tally?.voters.has(viewer) ?? false) : false };
}

function feedStory(date: string, story: EditionStory, tallies: Map<string, VoteTally>, viewer: string | null, images: Set<string>) {
  const imageId = story.sourceUrl ? `${date}/${legacyStoryId(date, story.sourceUrl)}` : null;
  const id = story.kind === "story" ? `daily:${date}:${story.index}` : `daily:${date}:signal:${story.index}`;
  return {
    id,
    type: storyType(story.title, story.sourceUrl),
    title: story.title,
    dek: story.dek,
    source: { name: sourceName(story.sourceUrl), url: story.sourceUrl },
    topics: [] as string[],
    image: imageId && images.has(imageId) ? imagePath("story", imageId) : null,
    published_at: `${date}${PUBLISH_HOUR}`,
    ...voteFields(tallies, id, viewer),
    href: story.kind === "story" ? `/archive/daily/${date}/${storySlug(story.title)}` : story.sourceUrl ?? `/archive/daily/${date}#quick-signals`,
    author: null,
    section: "daily" as const,
  };
}

function dekOf(markdown: string | null): string {
  const first = (markdown ?? "").split(/\n\s*\n/).map((part) => part.replace(/\[([^\]]*)]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return first.length > 240 ? `${first.slice(0, 239).trimEnd()}…` : first;
}

// Issues from the signal-first pipeline carry story records: stable ids, explicit topics and types.
function recordStory(date: string, publishedAt: string, story: StoryRecord, tallies: Map<string, VoteTally>, viewer: string | null, image: string | null) {
  const id = `daily:${date}:${story.id}`;
  return {
    id,
    type: story.type,
    title: story.headline,
    dek: dekOf(story.body),
    source: { name: sourceName(story.url), url: story.url },
    topics: story.topics,
    image,
    published_at: publishedAt,
    ...voteFields(tallies, id, viewer),
    // Featured stories have their own page; a signal is a headline and a link, so it goes to its source.
    href: story.role === "signal" ? story.url : `/archive/daily/${date}/${storySlug(story.headline)}`,
    author: null,
    section: "daily" as const,
  };
}

async function publishedAt(date: string): Promise<string> {
  const marker = publishedMarkerSchema.safeParse(await readPrivateJson(`published/daily/${date}.json`));
  return marker.success ? marker.data.publishedAt : `${date}${PUBLISH_HOUR}`;
}

/** Stories from the reader's archive window, newest edition first, in edition order within a day. */
export async function readerFeed(request: Request, limit: number, now = new Date(), resend?: Resend) {
  const email = readerEmail(request);
  const viewer = email ? readerHash(email) : null;
  const [identity, dates, tallies, covers] = await Promise.all([
    archiveIdentity(request, resend).catch(() => ({ tier: "free" as const, email: null })),
    publishedDates("daily"),
    voteTallies(),
    imageIds("story"),
  ]);
  const earliest = archiveWindowStart(identity.tier, now);
  const recent = dates.filter((date) => date >= earliest).slice(0, MAX_EDITIONS);
  const editions = await Promise.all(
    recent.map(async (date) => {
      try {
        const issue = await loadIssue(date);
        if (!issue) return [];
        if (issue.version === 1) return editionStories(issue.markdown).map((story) => feedStory(date, story, tallies, viewer, covers));
        const at = await publishedAt(date);
        return issue.stories.map((story) => {
          const id = `${date}/${story.id}`;
          return recordStory(date, at, story, tallies, viewer, covers.has(id) ? imagePath("story", id) : null);
        });
      } catch {
        return [];
      }
    }),
  );
  const stories = editions.flat();
  return { stories: stories.slice(0, limit) };
}

function editorialPiece(article: Article, tallies: Map<string, VoteTally>, viewer: string | null, covers: Set<string>) {
  const id = `editorial:${article.slug}`;
  return {
    id,
    title: article.title,
    dek: article.dek,
    author: article.author,
    kind: article.kind,
    image: article.image ?? (covers.has(article.slug) ? imagePath("editorial", article.slug) : null),
    published_at: article.publishedAt,
    href: `/archive/editorial/${article.slug}`,
    topics: article.topics,
    ai_generated: article.ai,
    sources: article.sources,
    ...voteFields(tallies, id, viewer),
  };
}

export async function readerEditorial(request: Request, now = new Date()) {
  const email = readerEmail(request);
  const viewer = email ? readerHash(email) : null;
  const [articles, tallies, covers] = await Promise.all([listArticles(now), voteTallies(), imageIds("editorial")]);
  return { pieces: articles.map((article) => editorialPiece(article, tallies, viewer, covers)) };
}

export async function readerArticle(request: Request, slug: string, now = new Date()) {
  const article = await loadArticle(slug);
  if (!article || Date.parse(article.publishedAt) > now.getTime()) return null;
  const email = readerEmail(request);
  const [tallies, covers] = await Promise.all([voteTallies(), imageIds("editorial")]);
  return { ...editorialPiece(article, tallies, email ? readerHash(email) : null, covers), markdown: article.markdown };
}
