import { FEED_TOPICS } from "./issue.js";

// What the engine knows about a reader comes from their Resend contact: the plan the billing webhooks keep authoritative, and the
// reading profile the website saved at onboarding. A reader is never given more than the properties say, and a profile that cannot
// be used is no profile. The website's schema is the authority; this reads it as leniently as it can without guessing.

export type Tier = "free" | "personal" | "professional";
export type Topic = (typeof FEED_TOPICS)[number];
export const CONTENT_TYPES = ["News", "Papers", "Models", "Repos"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export type ReaderProfile = { firstName: string | null; topics: Topic[]; content: ContentType[]; format: "Briefing" | "Links only"; notes: string };

type Properties = Record<string, { value?: unknown } | undefined> | null | undefined;
const valueOf = (properties: Properties, key: string): unknown => properties?.[key]?.value;

/** The plan billing says: an active plan, or a trial that has not ended, which is Personal. */
export function tierFromProperties(properties: Properties, now: number = Date.now()): Tier {
  const status = valueOf(properties, "personal_status");
  const plan = valueOf(properties, "personal_plan");
  const trialEndsAt = valueOf(properties, "personal_trial_ends_at");
  if (status === "active" && plan === "professional") return "professional";
  if (status === "active" && plan === "personal") return "personal";
  if (status === "trial" && typeof trialEndsAt === "string" && Date.parse(trialEndsAt) > now) return "personal";
  return "free";
}

const MAX_STORED_PROFILE = 10_000;
const MAX_NOTES = 180;
const NAME = /^[\p{L}'’-]{1,40}$/u;

const known = <T extends string>(values: unknown, allowed: readonly T[]): T[] => {
  if (!Array.isArray(values)) return [];
  const found = values.flatMap((value) => typeof value === "string" ? allowed.filter((entry) => entry.toLowerCase() === value.trim().toLowerCase()) : []);
  return [...new Set(found)];
};

function profileFrom(stored: unknown): ReaderProfile | null {
  if (typeof stored !== "string" || !stored || stored.length > MAX_STORED_PROFILE) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const topics = known(raw.topics, FEED_TOPICS);
  if (!topics.length) return null;
  const content = known(raw.content, CONTENT_TYPES);
  const first = typeof raw.firstName === "string" ? raw.firstName.trim().split(/\s+/)[0] : "";
  return {
    firstName: first && NAME.test(first) ? first : null,
    topics,
    content: content.length ? content : [...CONTENT_TYPES],
    format: typeof raw.format === "string" && raw.format.trim().toLowerCase() === "links only" ? "Links only" : "Briefing",
    notes: typeof raw.notes === "string" ? raw.notes.replace(/\s+/g, " ").trim().slice(0, MAX_NOTES) : "",
  };
}

export function readerFromProperties(properties: Properties, now: number = Date.now()): { tier: Tier; profile: ReaderProfile | null } {
  return { tier: tierFromProperties(properties, now), profile: profileFrom(valueOf(properties, "onboarding_profile")) };
}
