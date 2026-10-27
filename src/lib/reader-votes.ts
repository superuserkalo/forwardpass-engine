import { createHash } from "node:crypto";
import { loadArticle } from "./articles.js";
import { loadIssue } from "./issue.js";
import { editionStories } from "./edition-stories.js";
import { deletePrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "./private-store.js";

/**
 * Reader upvotes. One private object per (story, reader): `votes/<story path>/<sha256(email)>.json`.
 * Voting writes it and un-voting deletes it, so the count is the number of objects under the story path
 * and repeating the same request never changes the total.
 */

type StoryRef =
  | { kind: "edition"; section: "daily" | "weekly"; date: string }
  | { kind: "story" | "signal"; date: string; index: number }
  | { kind: "record"; date: string; storyId: string }
  | { kind: "editorial"; slug: string };

const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const EDITION_ID = new RegExp(`^(daily|weekly):${DATE}$`);
const STORY_ID = new RegExp(`^daily:${DATE}:(\\d{1,3})$`);
const SIGNAL_ID = new RegExp(`^daily:${DATE}:signal:(\\d{1,3})$`);
const RECORD_ID = new RegExp(`^daily:${DATE}:(s-[a-f0-9]{16})$`);
const EDITORIAL_ID = /^editorial:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function parseStoryId(id: string): StoryRef | null {
  if (id.length > 160) return null;
  const edition = EDITION_ID.exec(id);
  if (edition) return { kind: "edition", section: edition[1] as "daily" | "weekly", date: edition[2] };
  const story = STORY_ID.exec(id);
  if (story) return { kind: "story", date: story[1], index: Number(story[2]) };
  const signal = SIGNAL_ID.exec(id);
  if (signal) return { kind: "signal", date: signal[1], index: Number(signal[2]) };
  const record = RECORD_ID.exec(id);
  if (record) return { kind: "record", date: record[1], storyId: record[2] };
  const editorial = EDITORIAL_ID.exec(id);
  if (editorial && editorial[1].length <= 120) return { kind: "editorial", slug: editorial[1] };
  return null;
}

function storyPath(ref: StoryRef): string {
  switch (ref.kind) {
    case "edition":
      return `votes/${ref.section}/${ref.date}/edition/`;
    case "story":
      return `votes/daily/${ref.date}/story-${ref.index}/`;
    case "signal":
      return `votes/daily/${ref.date}/signal-${ref.index}/`;
    case "record":
      return `votes/daily/${ref.date}/${ref.storyId}/`;
    case "editorial":
      return `votes/editorial/${ref.slug}/`;
  }
}

export function readerHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Whether the story is something readers can actually see. Unknown ids are rejected. */
export async function storyExists(ref: StoryRef): Promise<boolean> {
  if (ref.kind === "editorial") return (await loadArticle(ref.slug)) !== null;
  const section = ref.kind === "edition" ? ref.section : "daily";
  if (!(await readPrivateJson(`published/${section}/${ref.date}.json`))) return false;
  if (ref.kind === "edition") return true;
  try {
    const issue = await loadIssue(ref.date);
    if (!issue) return false;
    if (ref.kind === "record") return issue.version === 2 && issue.stories.some((story) => story.id === ref.storyId);
    return issue.version === 1 && editionStories(issue.markdown).some((story) => story.kind === ref.kind && story.index === ref.index);
  } catch {
    return false;
  }
}

export type VoteTally = { count: number; voters: Set<string> };

/** Every vote in one listing, keyed by story id. One paginated list call covers the whole feed. */
export async function voteTallies(): Promise<Map<string, VoteTally>> {
  const tallies = new Map<string, VoteTally>();
  for (const key of await listPrivateJsonKeys("votes/")) {
    const match = /^votes\/(.+)\/([a-f0-9]{64})\.json$/.exec(key);
    if (!match) continue;
    const id = storyIdFromPath(match[1]);
    if (!id) continue;
    const tally = tallies.get(id) ?? { count: 0, voters: new Set<string>() };
    tally.count += 1;
    tally.voters.add(match[2]);
    tallies.set(id, tally);
  }
  return tallies;
}

function storyIdFromPath(path: string): string | null {
  const edition = /^(daily|weekly)\/(\d{4}-\d{2}-\d{2})\/edition$/.exec(path);
  if (edition) return `${edition[1]}:${edition[2]}`;
  const record = /^daily\/(\d{4}-\d{2}-\d{2})\/(s-[a-f0-9]{16})$/.exec(path);
  if (record) return `daily:${record[1]}:${record[2]}`;
  const story = /^daily\/(\d{4}-\d{2}-\d{2})\/(story|signal)-(\d+)$/.exec(path);
  if (story) return story[2] === "story" ? `daily:${story[1]}:${story[3]}` : `daily:${story[1]}:signal:${story[3]}`;
  const editorial = /^editorial\/([a-z0-9-]+)$/.exec(path);
  return editorial ? `editorial:${editorial[1]}` : null;
}

export async function setVote(ref: StoryRef, email: string, voted: boolean, now = new Date()): Promise<void> {
  const key = `${storyPath(ref)}${readerHash(email)}.json`;
  if (voted) await writePrivateJson(key, { votedAt: now.toISOString() });
  else await deletePrivateJson(key);
}

export async function storyTally(ref: StoryRef, email: string): Promise<{ upvotes: number; viewerHasUpvoted: boolean }> {
  const prefix = storyPath(ref);
  const keys = await listPrivateJsonKeys(prefix);
  const mine = `${prefix}${readerHash(email)}.json`;
  return { upvotes: keys.length, viewerHasUpvoted: keys.includes(mine) };
}

const WINDOW_MS = 60_000;
const MAX_WRITES = 60;
const recentWrites = new Map<string, number[]>();

/** Best-effort per-instance limit on vote writes per reader. */
export function allowVoteWrite(email: string, now = Date.now()): boolean {
  const hash = readerHash(email);
  const recent = (recentWrites.get(hash) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_WRITES) {
    recentWrites.set(hash, recent);
    return false;
  }
  recent.push(now);
  recentWrites.set(hash, recent);
  return true;
}
