import { z } from "zod";
import { getArchiveEntry, listArchive } from "../lib/archive.js";
import { imagePath, issueImageMeta, issueSubjects, leadStory, loadImage, type ImageKind } from "../lib/cover-images.js";
import { loadIssue } from "../lib/issue.js";
import { currentSourceCounts } from "../lib/source-count.js";
import { readerArticle, readerEditorial, readerEmail, readerFeed } from "../lib/reader-feed.js";
import { allowVoteWrite, parseStoryId, setVote, storyExists, storyTally } from "../lib/reader-votes.js";
import type { SignalService } from "../lib/signal-service.js";
import { handleSignalsRequest } from "./signals.js";

// The website's reader API, unchanged in shape from the Eve channels it replaces:
// /archive, /archive/:kind/:date, /feed, /editorial, /editorial/:slug and POST /votes,
// plus /images/:kind/:id for story and article images, and the live signals (/signals, /corrections) when a service is given.

const noStore = { "Cache-Control": "no-store" };
const voteSchema = z.object({ id: z.string().min(1).max(160), voted: z.boolean() });

/** Story id → the image path, its credit and the story's page slug, for stories that have an image. */
async function storyImages(date: string): Promise<Record<string, { path: string; credit: string | null; source: string | null; slug: string | null }>> {
  const [meta, issue] = await Promise.all([issueImageMeta(date), loadIssue(date)]);
  const slugs = new Map(issue ? issueSubjects(date, issue).map((story) => [story.id, story.slug]) : []);
  return Object.fromEntries([...meta].map(([id, { credit, sourceUrl }]) => [id, { path: imagePath("story", `${date}/${id}`), credit, source: sourceUrl, slug: slugs.get(id) ?? null }]));
}

async function guarded(label: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error("forwardpass.api_error", JSON.stringify({ label, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }));
    return new Response(`${label} unavailable`, { status: 503 });
  }
}

export async function handleReaderRequest(request: Request, path: string, signals?: SignalService): Promise<Response> {
  const method = request.method;
  // The live signals, when the service is wired in; without one this API is as it was.
  const signalResponse = signals ? await handleSignalsRequest(request, path, signals) : null;
  if (signalResponse) return signalResponse;
  // Public counts for the website's trust strip. They only change as sources are added or retired.
  if (method === "GET" && path === "/stats") return guarded("Stats", async () => Response.json(await currentSourceCounts(), { headers: { "Cache-Control": "public, max-age=300" } }));
  if (method === "GET" && path === "/archive") return guarded("Archive", async () => Response.json(await listArchive(request), { headers: noStore }));
  const entry = /^\/archive\/(daily|weekly)\/([^/]+)$/.exec(path);
  if (method === "GET" && entry) {
    return guarded("Archive", async () => {
      const result = await getArchiveEntry(request, entry[1] as "daily" | "weekly", entry[2]);
      const headers = new Headers({ "Content-Type": "text/markdown; charset=utf-8", ...noStore });
      if (result.status === 200 && entry[1] === "daily") {
        const images = await storyImages(entry[2]);
        if (Object.keys(images).length > 0) headers.set("X-Story-Images", JSON.stringify(images));
        const lead = await loadIssue(entry[2]).then((issue) => {
          if (issue?.version === 2) return leadStory(issue.stories)?.id;
          return issue ? issueSubjects(entry[2], issue)[0]?.id : undefined;
        });
        if (lead && images[lead]) headers.set("X-Cover-Image", images[lead].path);
      }
      return new Response(result.text, { status: result.status, headers });
    });
  }
  const image = /^\/images\/(story|editorial|daily)\/((?:\d{4}-\d{2}-\d{2}\/)?[^/]+)$/.exec(path);
  if (method === "GET" && image) {
    return guarded("Image", async () => {
      // Images illustrate published, public pages and never change once stored.
      const cover = await loadImage(image[1] as ImageKind, image[2]);
      if (!cover) return new Response("Image not found", { status: 404 });
      return new Response(Buffer.from(cover.base64, "base64"), {
        headers: { "Content-Type": cover.mediaType, "Cache-Control": "public, max-age=31536000, immutable" },
      });
    });
  }
  if (method === "GET" && path === "/feed") {
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? 48);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 48;
    return guarded("Feed", async () => Response.json(await readerFeed(request, limit), { headers: noStore }));
  }
  if (method === "GET" && path === "/editorial") return guarded("Editorial", async () => Response.json(await readerEditorial(request), { headers: noStore }));
  const article = /^\/editorial\/([^/]+)$/.exec(path);
  if (method === "GET" && article) {
    return guarded("Editorial", async () => {
      const found = await readerArticle(request, article[1]);
      return found ? Response.json(found, { headers: noStore }) : new Response("Article not found", { status: 404 });
    });
  }
  if (method === "POST" && path === "/votes") {
    const email = readerEmail(request);
    if (!email) return new Response("Sign in from your latest email to vote", { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
    const input = voteSchema.safeParse(body);
    if (!input.success) return new Response("Expected { id, voted }", { status: 400 });
    const ref = parseStoryId(input.data.id);
    if (!ref) return new Response("Unknown story", { status: 404 });
    if (!allowVoteWrite(email)) return new Response("Too many votes, try again in a minute", { status: 429 });
    return guarded("Votes", async () => {
      if (!(await storyExists(ref))) return new Response("Unknown story", { status: 404 });
      await setVote(ref, email, input.data.voted);
      const tally = await storyTally(ref, email);
      return Response.json({ id: input.data.id, upvotes: tally.upvotes, viewer_has_upvoted: tally.viewerHasUpvoted }, { headers: noStore });
    });
  }
  return new Response("Not found", { status: 404 });
}
