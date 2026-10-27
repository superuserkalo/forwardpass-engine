import { gateway } from "@ai-sdk/gateway";
import { generateImage } from "ai";
import { z } from "zod";
import { structured } from "../pipeline/models.js";
import { articleSlugSchema, loadArticle } from "./articles.js";
import { editionStories } from "./edition-stories.js";
import { loadIssue, storyId, type StoryRecord } from "./issue.js";
import { deletePrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "./private-store.js";
import { findSourceImage } from "./source-images.js";

// Every story in an issue gets the picture its own source publishes (AlphaSignal's approach:
// the real figure, screenshot or share image, re-hosted and credited). A featured story whose
// sources have none, and an editorial piece without its own image, get an illustration drawn
// from a concrete scene a model writes for that story. Muse Image costs $0.01 an image.

export type ImageKind = "story" | "editorial" | "daily";

const DEFAULT_MODEL = "meta/muse-image-1.0";
const MAX_BYTES = 4_000_000;

const imageSchema = z.object({
  version: z.literal(1),
  mediaType: z.enum(["image/webp", "image/png", "image/jpeg"]),
  base64: z.string().min(1),
  origin: z.enum(["source", "generated"]).default("generated"),
  sourceUrl: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  credit: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  prompt: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type StoredImage = z.infer<typeof imageSchema>;

const storyIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}\/s-[a-f0-9]{16}$/);
// "daily" holds the one cover per issue drawn before stories had their own images.
const ids: Record<ImageKind, z.ZodType<string>> = { story: storyIdSchema, editorial: articleSlugSchema, daily: z.iso.date() };

const imageKey = (kind: ImageKind, id: string) => `images/${kind}/${ids[kind].parse(id)}.json`;

/** The website path that serves an image. */
export const imagePath = (kind: ImageKind, id: string) => `/media/${kind}/${id}`;

/** The story's own page on the website, from its headline. The website derives the same slug. */
export function storySlug(headline: string): string {
  const slug = headline.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= 80) return slug || "story";
  const cut = slug.slice(0, 81);
  return cut.slice(0, cut.lastIndexOf("-") > 40 ? cut.lastIndexOf("-") : 80).replace(/-+$/g, "");
}

export async function loadImage(kind: ImageKind, id: string): Promise<StoredImage | null> {
  if (!ids[kind].safeParse(id).success) return null;
  const parsed = imageSchema.safeParse(await readPrivateJson(imageKey(kind, id)));
  return parsed.success ? parsed.data : null;
}

/** Ids that have an image, from one listing instead of reading each image. */
export async function imageIds(kind: ImageKind): Promise<Set<string>> {
  const prefix = `images/${kind}/`;
  const keys = await listPrivateJsonKeys(prefix);
  return new Set(keys.map((key) => key.slice(prefix.length, -".json".length)));
}

const plain = (markdown: string) => markdown.replace(/\[([^\]]*)]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();

const briefSchema = z.object({ scene: z.string().min(20).max(700) });

const BRIEF_SYSTEM = `You art-direct one illustration for a news story read by AI engineers.
Describe a single concrete scene that literally shows what the story is about: the product doing its job, the capability in action, or the result being compared. Name real, drawable things (a terminal window, a laptop running a desktop app, a server rack, a benchmark chart with two bars, a robotic arm clicking a button). Avoid puns on names, abstract metaphors, letters, symbols and anything that needs text to make sense.
No people's faces, no logos, no brand marks, no readable text or numbers. One or two sentences.`;

async function sceneFor(headline: string, summary: string): Promise<string> {
  const { output } = await structured("image-brief", "facts", briefSchema, BRIEF_SYSTEM, `Headline: ${headline.trim()}\n\nStory: ${summary.slice(0, 1500)}`, 600);
  return output.scene;
}

export function illustrationPrompt(scene: string): string {
  return [
    `Editorial illustration for an AI engineering newsletter. Scene: ${scene.trim()}`,
    "Style: clean technical illustration, near-black background, warm off-white ink with one muted accent colour, fine line work with subtle halftone shading, flat print look, generous negative space, wide landscape composition.",
    "No text, no letters, no numbers, no logos, no brand marks, no faces.",
  ].join(" ");
}

export async function drawImage(headline: string, summary: string): Promise<Omit<StoredImage, "version" | "createdAt">> {
  const model = process.env.IMAGE_MODEL || DEFAULT_MODEL;
  const prompt = illustrationPrompt(await sceneFor(headline, summary));
  const { image } = await generateImage({ model: gateway.image(model), prompt, maxRetries: 2 });
  if (image.uint8Array.byteLength > MAX_BYTES) throw new Error(`Generated image is ${image.uint8Array.byteLength} bytes`);
  return { mediaType: imageSchema.shape.mediaType.parse(image.mediaType), base64: image.base64, origin: "generated", sourceUrl: null, imageUrl: null, credit: null, model, prompt };
}

const metaSchema = z.object({ origin: z.enum(["source", "generated"]), credit: z.string().nullable(), sourceUrl: z.string().nullable() });
export type ImageMeta = z.infer<typeof metaSchema>;

// Images run to a megabyte of base64, so who to credit sits beside each one in a small file.
const metaKey = (kind: ImageKind, id: string) => `images-meta/${kind}/${ids[kind].parse(id)}.json`;

async function save(kind: ImageKind, id: string, image: Omit<StoredImage, "version" | "createdAt">): Promise<void> {
  await writePrivateJson(imageKey(kind, id), imageSchema.parse({ version: 1, ...image, createdAt: new Date().toISOString() }));
  await writePrivateJson(metaKey(kind, id), metaSchema.parse({ origin: image.origin, credit: image.credit, sourceUrl: image.sourceUrl }));
}

/** Credits for the stories of one issue that have an image, keyed by story id. */
export async function issueImageMeta(date: string): Promise<Map<string, ImageMeta>> {
  const prefix = `images-meta/story/${z.iso.date().parse(date)}/`;
  const keys = await listPrivateJsonKeys(prefix);
  const entries = await Promise.all(keys.map(async (key) => {
    const meta = metaSchema.safeParse(await readPrivateJson(key));
    return meta.success ? [[key.slice(prefix.length, -".json".length), meta.data]] as const : [];
  }));
  return new Map(entries.flat());
}

type Outcome = "source" | "generated" | "exists";

/** What finding or drawing an image needs from a story, for both issue formats. */
type ImageSubject = { id: string; headline: string; summary: string; urls: string[] };

/** Stories saved before story records (24 September) get an id from their date and source URL. */
export function legacyStoryId(date: string, sourceUrl: string): string {
  return storyId(date, sourceUrl);
}

async function ensureStoryImage(date: string, story: ImageSubject): Promise<Outcome> {
  const id = `${date}/${story.id}`;
  if (await loadImage("story", id)) return "exists";
  const found = await findSourceImage(story.urls);
  if (found) {
    await save("story", id, { mediaType: imageSchema.shape.mediaType.parse(found.mediaType), base64: Buffer.from(found.bytes).toString("base64"), origin: "source", sourceUrl: found.sourceUrl, imageUrl: found.imageUrl, credit: found.credit, model: null, prompt: null });
    return "source";
  }
  // Every story shows an image: a signal is a headline and a link, so its headline is the brief.
  await save("story", id, await drawImage(story.headline, story.summary || story.headline));
  return "generated";
}

export type IssueSubject = ImageSubject & { slug: string };

/** Every story an issue shows, with the slug of its page on the website, for every issue format. */
export function issueSubjects(date: string, issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>): IssueSubject[] {
  if (issue.version === 2) {
    return [...issue.stories].sort((a, b) => a.position - b.position).map((story) => ({
      id: story.id, slug: storySlug(story.headline), headline: story.headline, summary: plain(story.body ?? ""), urls: [story.url, ...story.sources.map((source) => source.url)],
    }));
  }
  const numbered = editionStories(issue.markdown).flatMap((story) => story.sourceUrl
    ? [{ id: legacyStoryId(date, story.sourceUrl), slug: storySlug(story.title), headline: story.title, summary: story.dek, urls: [story.sourceUrl] }]
    : []);
  if (numbered.length > 0) return numbered;
  // Markdown issues from the first days head each section with "## "; the website pages them by that heading.
  return issue.markdown.split(/^##\s+/m).slice(1).flatMap((part) => {
    const [heading = "", ...rest] = part.split("\n");
    const body = rest.join("\n");
    const urls = [...body.matchAll(/\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s)>\]]+)/g)].map((match) => match[1] ?? match[2]);
    const title = plain(heading);
    return title ? [{ id: legacyStoryId(date, urls[0] ?? `heading:${title}`), slug: storySlug(title), headline: title.replace(/^\d{1,2}\s+[—–-]\s+/, ""), summary: plain(body).slice(0, 1500), urls: urls.slice(0, 4) }] : [];
  });
}

/** An image for every story in the issue. Each story is independent, so one failure skips only it. */
export async function ensureIssueImages(date: string): Promise<Record<string, Outcome | string>> {
  const issue = await loadIssue(date);
  if (!issue) return {};
  const results: Record<string, Outcome | string> = {};
  for (const story of issueSubjects(date, issue)) {
    results[story.id] = await ensureStoryImage(date, story).catch((error: unknown) => `failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
  }
  return results;
}

/** Drops an issue's images so the next run finds or draws them again. */
export async function clearIssueImages(date: string): Promise<void> {
  z.iso.date().parse(date);
  for (const prefix of [`images/story/${date}/`, `images-meta/story/${date}/`]) {
    for (const key of await listPrivateJsonKeys(prefix)) await deletePrivateJson(key);
  }
  await deletePrivateJson(imageKey("daily", date));
}

/** Draws an image for an editorial piece that has none of its own. */
export async function ensureArticleImage(slug: string, replace = false): Promise<Outcome | "skipped"> {
  const article = await loadArticle(slug);
  if (!article || article.image) return "skipped";
  if (!replace && await loadImage("editorial", slug)) return "exists";
  await save("editorial", slug, await drawImage(article.title, article.dek || plain(article.markdown).slice(0, 1500)));
  return "generated";
}

export function leadStory(stories: StoryRecord[]): StoryRecord | undefined {
  return [...stories].filter((story) => story.role === "featured").sort((a, b) => a.position - b.position)[0] ?? stories[0];
}

/** Reuses a story's image for the article written about it. Returns false when the story has none. */
export async function copyStoryImageToArticle(date: string, storyId: string, slug: string): Promise<boolean> {
  const stored = await loadImage("story", `${date}/${storyId}`);
  if (!stored) return false;
  const { version: _version, createdAt: _createdAt, ...image } = stored;
  await save("editorial", slug, image);
  return true;
}
