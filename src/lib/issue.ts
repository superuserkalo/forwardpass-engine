import { createHash } from "node:crypto";
import { z } from "zod";
import { createPrivateJson, readPrivateJson } from "./private-store.js";

// The published daily issue. Stories are records with stable IDs, so the email, the
// archive, the feed, votes and future personal editions all refer to the same story
// no matter how an edition orders or filters them. Markdown is derived from the records.

export const FEED_TOPICS = [
  "Agents", "APIs", "Audio", "Benchmarks", "Business", "Chips", "Data", "Data centers", "Development", "GPUs", "Image", "Infrastructure",
  "LLMs", "Open source", "Post-training", "Reasoning", "Retrieval", "Robotics", "Security", "Training", "Video", "Vibe coding",
] as const;

export const storyTypeSchema = z.enum(["news", "papers", "models", "repos"]);
export type StoryType = z.infer<typeof storyTypeSchema>;

export const factSchema = z.object({ fact: z.string(), quote: z.string(), impact: z.number() });

export const storyRecordSchema = z.object({
  id: z.string().regex(/^s-[a-f0-9]{16}$/),
  role: z.enum(["featured", "signal"]),
  position: z.number().int().nonnegative(),
  label: z.string(),
  type: storyTypeSchema,
  headline: z.string().min(1),
  /** Markdown body for featured stories; signals are a headline and a link. */
  body: z.string().nullable(),
  /** A signal's summary for a reader's own edition: one or two sentences of the source's own description, never written by a model. */
  excerpt: z.string().max(300).optional(),
  url: z.string().url(),
  sources: z.array(z.object({ label: z.string(), url: z.string().url() })),
  traction: z.string().nullable(),
  topics: z.array(z.enum(FEED_TOPICS)),
  project: z.string().nullable(),
  /** When the source published it, when known. */
  publishedAt: z.string().nullable(),
  facts: z.array(factSchema),
});
export type StoryRecord = z.infer<typeof storyRecordSchema>;

export const usageSchema = z.object({
  step: z.string(), model: z.string(), ms: z.number(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cost: z.number().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const issueV2Schema = z.object({
  version: z.literal(2),
  date: z.iso.date(),
  createdAt: z.iso.datetime(),
  subject: z.string().min(1),
  preview: z.string(),
  intro: z.array(z.string()).length(3),
  stories: z.array(storyRecordSchema).min(1),
  markdown: z.string().min(1),
  pipeline: z.object({
    candidates: z.number(), clusters: z.number(), shortlisted: z.number(), kept: z.number(),
    models: z.record(z.string(), z.string()),
    usage: z.array(usageSchema),
    checks: z.record(z.string(), z.unknown()),
  }),
});
export type IssueV2 = z.infer<typeof issueV2Schema>;

// Issues saved by the retired Eve pipeline (24 September) keep their Markdown.
const issueV1Schema = z.object({ version: z.literal(1), markdown: z.string() }).passthrough();

export type SavedIssue = IssueV2 | { version: 1; markdown: string };

export function storyId(date: string, url: string): string {
  return `s-${createHash("sha256").update(`${date}\n${url}`).digest("hex").slice(0, 16)}`;
}

export const issueKey = (date: string) => `issues/${z.iso.date().parse(date)}.json`;

export async function loadIssue(date: string): Promise<SavedIssue | null> {
  const value = await readPrivateJson(issueKey(date));
  if (value === null) return null;
  const version = z.object({ version: z.number() }).parse(value).version;
  if (version === 2) return issueV2Schema.parse(value);
  const legacy = issueV1Schema.parse(value);
  return { version: 1, markdown: legacy.markdown };
}

/** Issues are immutable: a retry may save the identical issue again, never a different one. */
export async function saveIssue(issue: IssueV2): Promise<void> {
  const parsed = issueV2Schema.parse(issue);
  if (await createPrivateJson(issueKey(parsed.date), parsed)) return;
  const existing = await loadIssue(parsed.date);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(parsed)) {
    throw new Error(`A different issue for ${parsed.date} is already saved.`);
  }
}

export const publishedMarkerSchema = z.object({
  version: z.number(), kind: z.enum(["daily", "weekly"]), date: z.iso.date(), publishedAt: z.iso.datetime(),
}).passthrough();

export async function markPublished(date: string, at: string): Promise<void> {
  await createPrivateJson(`published/daily/${date}.json`, { version: 2, kind: "daily", date, publishedAt: at });
}
