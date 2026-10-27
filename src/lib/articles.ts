import { z } from "zod";
import { deletePrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "./private-store.js";

/**
 * Long-form pieces (deep dives, tutorials, opinion, monthly reports), written by people or, with
 * `ai: true`, by the engine.
 * Served to the website as the Editorial section. Stored privately under `articles/<slug>.json`.
 */

export const articleSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);

export const articleSchema = z.object({
  version: z.literal(1),
  slug: articleSlugSchema,
  title: z.string().trim().min(1).max(200),
  dek: z.string().trim().max(400),
  author: z.string().trim().min(1).max(80),
  kind: z.enum(["deep-dive", "tutorial", "opinion", "report"]),
  image: z.url().nullable(),
  publishedAt: z.iso.datetime({ offset: true }),
  topics: z.array(z.string().trim().min(1).max(40)).max(8),
  markdown: z.string().min(1),
  /** Written by the engine (Sunday deep dives, monthly reports), disclosed as AI-generated. */
  ai: z.boolean().default(false),
  /** Primary sources the piece is based on, cited on the page and in its structured data. */
  sources: z.array(z.url()).max(30).default([]),
});

export type Article = z.infer<typeof articleSchema>;

function articleKey(slug: string): string {
  return `articles/${articleSlugSchema.parse(slug)}.json`;
}

export async function saveArticle(article: Article): Promise<void> {
  await writePrivateJson(articleKey(article.slug), articleSchema.parse(article));
}

/** Publishes a held draft (dated in the future) at `at`. */
export async function publishArticle(slug: string, at: string): Promise<Article | null> {
  const article = await loadArticle(slug);
  if (!article) return null;
  const published = { ...article, publishedAt: z.iso.datetime().parse(at) };
  await saveArticle(published);
  return published;
}

export async function removeArticle(slug: string): Promise<void> {
  await deletePrivateJson(articleKey(slug));
}

export async function loadArticle(slug: string): Promise<Article | null> {
  if (!articleSlugSchema.safeParse(slug).success) return null;
  const stored = articleSchema.safeParse(await readPrivateJson(articleKey(slug)));
  return stored.success ? stored.data : null;
}

/** Published pieces, newest first. Pieces dated in the future stay hidden until then. */
export async function listArticles(now = new Date()): Promise<Article[]> {
  const keys = await listPrivateJsonKeys("articles/");
  const articles = await Promise.all(
    keys.map(async (key) => articleSchema.safeParse(await readPrivateJson(key))),
  );
  return articles
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .filter((article) => Date.parse(article.publishedAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** Parses a markdown file with a simple `key: value` front matter block into an article. */
export function articleFromMarkdown(source: string, slugFallback: string): Article {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!match) throw new Error("Article needs a front matter block between --- lines.");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (field) fields.set(field[1], field[2].replace(/^["']|["']$/g, "").trim());
  }
  return articleSchema.parse({
    version: 1,
    slug: fields.get("slug") || slugFallback,
    title: fields.get("title"),
    dek: fields.get("dek") ?? "",
    author: fields.get("author"),
    kind: fields.get("kind"),
    image: fields.get("image") || null,
    publishedAt: fields.get("published_at") || new Date().toISOString(),
    topics: (fields.get("topics") ?? "").split(",").map((topic) => topic.trim()).filter(Boolean),
    markdown: match[2].trim(),
  });
}
