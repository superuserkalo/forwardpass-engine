import { Resend } from "resend";
import { z } from "zod";
import { loadWeekly } from "../pipeline/weekly.js";
import { loadIssue } from "./issue.js";
import { verifyPreferencesToken } from "./preference-link.js";
import { listPrivateJsonKeys, readPrivateJson } from "./private-store.js";
import { tierFromProperties, type Tier } from "./reader-profile.js";

export type ArchiveTier = Tier;
export type ArchiveKind = "daily" | "weekly";

function cutoff(months: number, now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

function windowMonths(tier: ArchiveTier): number {
  return tier === "professional" ? 24 : tier === "personal" ? 12 : 6;
}

/** Earliest edition date a reader on this tier may open. */
export function archiveWindowStart(tier: ArchiveTier, now = new Date()): string {
  return cutoff(windowMonths(tier), now);
}

export async function archiveIdentity(request: Request, resend?: Resend):
  Promise<{ tier: ArchiveTier; email: string | null }> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const email = bearer ? verifyPreferencesToken(bearer) : null;
  if (!email) return { tier: "free", email: null };
  const key = process.env.RESEND_API_KEY;
  if (!resend && !key) throw new Error("RESEND_API_KEY is not configured.");
  const { data, error } = await (resend ?? new Resend(key)).contacts.get({ email });
  if (error || !data) return { tier: "free", email: null };
  const tier = tierFromProperties(data.properties);
  return tier === "free" ? { tier: "free", email: null } : { tier, email };
}

export async function publishedDates(kind: ArchiveKind): Promise<string[]> {
  const keys = await listPrivateJsonKeys(`published/${kind}/`);
  return keys.flatMap((key) => {
    const match = key.match(/(\d{4}-\d{2}-\d{2})\.json$/);
    return match ? [match[1]] : [];
  }).sort().reverse();
}

export async function listArchive(request: Request, now = new Date(), resend?: Resend) {
  const [identity, dailyDates] = await Promise.all([
    archiveIdentity(request, resend),
    publishedDates("daily"),
  ]);
  const earliest = cutoff(windowMonths(identity.tier), now);
  const daily = dailyDates.filter((date) => date >= earliest);
  const weekly = identity.tier === "professional"
    ? (await publishedDates("weekly")).filter((date) => date >= earliest)
    : [];
  return { tier: identity.tier, daily, weekly };
}

export async function getArchiveEntry(
  request: Request,
  kind: ArchiveKind,
  date: string,
  now = new Date(),
  resend?: Resend,
): Promise<{ status: number; text: string }> {
  const day = z.iso.date().safeParse(date);
  if (!day.success) return { status: 400, text: "Invalid date" };
  const marker = await readPrivateJson(`published/${kind}/${day.data}.json`);
  if (!marker) return { status: 404, text: "Edition not published" };
  const identity = await archiveIdentity(request, resend);
  if (day.data < cutoff(windowMonths(identity.tier), now)) return { status: 403, text: "Outside your archive window" };
  // The weekly research is what a Professional reader pays for beyond the daily issue.
  if (kind === "weekly") {
    if (identity.tier !== "professional" || !identity.email) return { status: 403, text: "Professional subscription required" };
    const weekly = await loadWeekly(day.data);
    return weekly ? { status: 200, text: weekly.markdown } : { status: 404, text: "No weekly edition for this reader" };
  }
  const issue = await loadIssue(day.data);
  if (!issue) return { status: 404, text: "Edition not published" };
  return { status: 200, text: issue.version === 2 ? withStoryMarkers(issue.markdown, issue.stories) : issue.markdown };
}

/**
 * Marks each featured story's heading with its stable record id in an HTML comment, which
 * Markdown renderers hide. The website anchors and counts votes on that id, so feed links
 * (`#s-…`) and votes stay attached to the right story whatever the story's position.
 */
export function withStoryMarkers(markdown: string, stories: { id: string; role: string; headline: string }[]): string {
  const featured = new Map(stories.filter(({ role }) => role !== "signal").map(({ id, headline }) => [headline.trim(), id]));
  return markdown.split("\n").map((line) => {
    const heading = /^##\s+(.+)$/.exec(line)?.[1]?.trim();
    const id = heading ? featured.get(heading) : undefined;
    return id ? `<!-- story:${id} -->\n${line}` : line;
  }).join("\n");
}
