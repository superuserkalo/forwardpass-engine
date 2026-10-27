import { z } from "zod";
import { entryKey } from "../lib/entry-key.js";
import { FEED_TOPICS, loadIssue, type IssueV2, type Usage } from "../lib/issue.js";
import { createPrivateJson, deletePrivateJson, listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { visibleText } from "../lib/visible-text.js";
import { parseComputeTag } from "./compute.js";
import { plainProse } from "./excerpt.js";
import { languageOf } from "./language.js";
import { publisherDomain } from "./publisher-domain.js";
import { SIGNAL_GROUNDED, groundDrafts, looksLikeInstruction, sentencesOf, type GroundItem, type SummaryVerdict } from "./signal-writing.js";
import { IO_STEP, MODEL_STEP, type Steps } from "./steps.js";
import { linkText, mdText, mdUrl, overviewProblems, rangeLabel, writeOverviews, type OverviewDraft, type WriterTopic } from "./weekly.js";
import { cleanPunctuation } from "./writing.js";

// The weekly Compute report: the week of AI compute as the seven published daily issues reported it, for Professional readers who follow Chips or
// Data centers. Which stories are compute news is read from the tag code printed under their headlines, never guessed. Its numbers and counts are
// code, its stories and facts are the issues' own, and the prose between them is published only if a judge finds it supported by the facts it
// rests on. See docs/superpowers/specs/2026-10-10-weekly-compute-report-design.md.

const DAY_MS = 86_400_000;
const TOP = 5;
const TOP_PER_SITE = 2;
const SHOWN = 6;
const BASIS = 6;
const NUMBERS = 6;
const NUMBERS_PER_STORY = 2;
const FACTS_PER_ITEM = 3;
const RADAR = 8;
const MIN_RADAR_IMPORTANCE = 5;
const RADAR_TITLE_CHARS = 140;
const QUOTE_CHARS = 300;
const MIN_FOR_OVERVIEW = 2;
/** A week with fewer compute stories than this is not a report. */
export const MIN_STORIES = 4;
export const AREAS = ["Chips", "Data centers"] as const satisfies readonly (typeof FEED_TOPICS)[number][];
export type Area = (typeof AREAS)[number];

// ---- the edition

const iso = z.iso.datetime();
const secure = z.url({ protocol: /^https$/ });
const provenanceSchema = z.enum(["Official", "Reported", "Unconfirmed"]);
const languageSchema = z.enum(["Chinese", "Korean", "Japanese"]);
const factsSchema = z.array(z.object({ fact: z.string(), quote: z.string() }));

export const computeItemSchema = z.object({
  date: z.iso.date(),
  role: z.enum(["featured", "signal"]),
  headline: z.string(),
  /** Where the story is, always a secure web address: nothing else is ever published as one. */
  url: secure,
  site: z.string(),
  provenance: provenanceSchema,
  /** The language it was read in, when it was not English and was written up in English. */
  language: languageSchema.nullable(),
  /** The best verified facts, each beside the quote it was found in. */
  facts: factsSchema.max(FACTS_PER_ITEM),
});
export type ComputeItem = z.infer<typeof computeItemSchema>;

export const computeNumberSchema = z.object({
  fact: z.string(), quote: z.string(), date: z.iso.date(), headline: z.string(), url: secure, site: z.string(), provenance: provenanceSchema, language: languageSchema.nullable(),
});
export type ComputeNumber = z.infer<typeof computeNumberSchema>;

export const radarItemSchema = z.object({ date: z.iso.date(), title: z.string(), url: secure, site: z.string(), importance: z.number() });
export type RadarItem = z.infer<typeof radarItemSchema>;

export const computeAreaSchema = z.object({
  area: z.enum(AREAS),
  count: z.number().int(),
  previousCount: z.number().int(),
  /** Prose that the judge found supported by the area's facts, or null. */
  overview: z.string().nullable(),
  grounding: z.object({ headline: z.number(), summary: z.number() }).nullable(),
  items: z.array(computeItemSchema).max(SHOWN),
});
export type ComputeArea = z.infer<typeof computeAreaSchema>;

export const computeWeekSchema = z.object({
  version: z.literal(1),
  date: z.iso.date(),
  weekStart: iso,
  weekEnd: iso,
  generatedAt: iso,
  totals: z.object({
    stories: z.number().int(), featured: z.number().int(), official: z.number().int(), reported: z.number().int(), unconfirmed: z.number().int(),
    translated: z.number().int(), days: z.number().int(), previousStories: z.number().int(),
  }),
  top: z.array(computeItemSchema).max(TOP),
  numbers: z.array(computeNumberSchema).max(NUMBERS),
  areas: z.array(computeAreaSchema),
  radar: z.array(radarItemSchema).max(RADAR),
  evaluator: z.string(),
  markdown: z.string(),
});
export type ComputeWeek = z.infer<typeof computeWeekSchema>;

// ---- the plan

type PlanItem = ComputeItem & { position: number; topics: readonly string[]; figures: { fact: string; quote: string; impact: number }[] };
export type AreaPlan = { area: Area; count: number; previousCount: number; items: ComputeItem[]; basis: ComputeItem[]; wantsOverview: boolean };
export type ComputePlan = {
  date: string; weekStart: string; weekEnd: string; total: number; previousTotal: number; days: number;
  featured: number; official: number; reported: number; unconfirmed: number; translated: number;
  stories: ComputeItem[]; top: ComputeItem[]; numbers: ComputeNumber[]; areas: AreaPlan[]; radar: RadarItem[];
};

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const secureUrl = (value: string): boolean => { try { return new URL(value).protocol === "https:"; } catch { return false; } };
const keyOf = (url: string): string | null => { try { return entryKey(url); } catch { return null; } };

/** A fact with an amount in it: a currency, a percentage, or a number with a unit of the industry's. */
const UNIT = String.raw`(?:percent|billion|million|trillion|thousand|bn|GW|MW|kW|TB|GB|PB|nm|wafers?|chips?|units?|GPUs?|TPUs?|racks?|tons?)\b`;
const FIGURE = new RegExp(String.raw`(?:[$€£¥]\s?\d|\b(?:NT|US|HK|S)\$\s?\d|\b(?:USD|KRW|JPY|RMB|NTD)\s?\d|\d[\d,.]*\s?(?:%|${UNIT}))`, "i");

const rank = (a: PlanItem, b: PlanItem): number =>
  Number(b.role === "featured") - Number(a.role === "featured") || b.date.localeCompare(a.date) || a.position - b.position || a.headline.localeCompare(b.headline);

/** The compute stories one issue ran, as items: the ones with a tag from code and a secure address. */
function itemsOf(issue: IssueV2): PlanItem[] {
  return issue.stories.flatMap((story): PlanItem[] => {
    const tag = parseComputeTag(story.traction);
    if (!tag || !secureUrl(story.url)) return [];
    // A quote is the page's own words, and the page is anyone's: a fact and its quote are shown only if both are plain prose, with no link, address,
    // phone number or instruction in them, which a mail program would link or a model would read.
    const byImpact = story.facts.flatMap(({ fact, quote, impact }) => {
      const stated = plainProse(fact), quoted = plainProse(quote);
      return stated && quoted && quoted.length <= QUOTE_CHARS ? [{ fact: stated, quote: quoted, impact }] : [];
    }).sort((a, b) => b.impact - a.impact);
    return [{
      date: issue.date, role: story.role, headline: story.headline, url: story.url, site: tag.site, provenance: tag.provenance, language: tag.language,
      facts: byImpact.slice(0, FACTS_PER_ITEM).map(({ fact, quote }) => ({ fact, quote })), position: story.position, topics: story.topics,
      figures: byImpact.filter(({ fact }) => FIGURE.test(fact)),
    }];
  });
}

/** Each story once, the earliest issue's when two ran it. */
function uniqueStories(issues: IssueV2[]): PlanItem[] {
  const seen = new Set<string>();
  const out: PlanItem[] = [];
  for (const item of issues.flatMap(itemsOf)) {
    const key = keyOf(item.url) ?? item.url;
    const same = `${key}\n${item.headline.toLowerCase()}`;
    if (seen.has(key) || seen.has(same)) continue;
    seen.add(key); seen.add(same);
    out.push(item);
  }
  return out;
}

const poolSchema = z.object({ pool: z.array(z.object({ url: z.string(), title: z.string(), importance: z.number() })) });

/** What triage ranked as compute news and no issue of these weeks ran, as the sources headlined it. Text of theirs, so it is held to a plain line in English. */
function radarOf(issues: IssueV2[], ran: Set<string>): RadarItem[] {
  const found = new Map<string, RadarItem>();
  for (const issue of issues) {
    const parsed = poolSchema.safeParse(issue.pipeline.checks.compute);
    if (!parsed.success) continue;
    for (const entry of parsed.data.pool) {
      const title = visibleText(entry.title).replace(/\s+/g, " ").trim();
      const key = keyOf(entry.url);
      if (!key || !secureUrl(entry.url) || ran.has(key) || entry.importance < MIN_RADAR_IMPORTANCE) continue;
      if (!title || title.length > RADAR_TITLE_CHARS || languageOf(title) || [entry.title, title].some(looksLikeInstruction) || !plainProse(title)) continue;
      const host = new URL(entry.url).hostname.replace(/^www\./, "");
      const item = { date: issue.date, title, url: entry.url, site: publisherDomain(host), importance: entry.importance };
      const before = found.get(key);
      if (!before || before.importance < item.importance) found.set(key, item);
    }
  }
  const titles = new Set<string>();
  return [...found.values()].sort((a, b) => b.importance - a.importance || b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
    .filter(({ title }) => { const key = title.toLowerCase(); if (titles.has(key)) return false; titles.add(key); return true; }).slice(0, RADAR);
}

/**
 * The week ending on `date`: its stories, counts, top, numbers, areas and radar, from the daily issues of that week and the week before it. The
 * result does not depend on the order the issues are given in.
 */
export function planComputeWeek(issues: IssueV2[], date: string): ComputePlan {
  const end = dayStart(date);
  const start = end - 6 * DAY_MS;
  const byDate = new Map(issues.map((issue) => [issue.date, issue]));
  const within = (from: number, to: number) => [...byDate.values()].filter((issue) => dayStart(issue.date) >= from && dayStart(issue.date) <= to).sort((a, b) => a.date.localeCompare(b.date));
  const week = within(start, end);
  const before = within(start - 7 * DAY_MS, start - DAY_MS);
  const stories = uniqueStories(week).sort(rank);
  const previous = uniqueStories(before);

  const perSite = new Map<string, number>();
  const top: PlanItem[] = [];
  for (const item of stories) {
    if ((perSite.get(item.site) ?? 0) >= TOP_PER_SITE) continue;
    perSite.set(item.site, (perSite.get(item.site) ?? 0) + 1);
    top.push(item);
    if (top.length === TOP) break;
  }

  const shown = (item: PlanItem): ComputeItem => computeItemSchema.parse(item);
  const areas: AreaPlan[] = AREAS.flatMap((area) => {
    const own = stories.filter((item) => item.topics.includes(area));
    if (!own.length) return [];
    const basis = own.filter((item) => item.facts.length).slice(0, BASIS).map(shown);
    return [{ area, count: own.length, previousCount: previous.filter((item) => item.topics.includes(area)).length, items: own.slice(0, SHOWN).map(shown), basis, wantsOverview: basis.length >= MIN_FOR_OVERVIEW }];
  }).sort((a, b) => b.count - a.count || a.area.localeCompare(b.area));

  // The figures featured stories gave, most telling first, a story's two best at most.
  const taken = new Map<string, number>();
  const numbers = stories.filter((item) => item.role === "featured")
    .flatMap((item) => item.figures.slice(0, NUMBERS_PER_STORY).map((figure) => ({ item, figure })))
    .sort((a, b) => b.figure.impact - a.figure.impact || b.item.date.localeCompare(a.item.date) || a.item.headline.localeCompare(b.item.headline) || a.figure.fact.localeCompare(b.figure.fact))
    .filter(({ item }) => { const n = taken.get(item.url) ?? 0; taken.set(item.url, n + 1); return n < NUMBERS_PER_STORY; })
    .slice(0, NUMBERS)
    .map(({ item, figure }) => computeNumberSchema.parse({ fact: figure.fact, quote: figure.quote, date: item.date, headline: item.headline, url: item.url, site: item.site, provenance: item.provenance, language: item.language }));

  const ran = new Set([...week, ...before].flatMap((issue) => issue.stories.flatMap((story) => [story.url, ...story.sources.map(({ url }) => url)])).flatMap((url) => keyOf(url) ?? []));
  const count = (provenance: string) => stories.filter((item) => item.provenance === provenance).length;
  return {
    date, weekStart: new Date(start).toISOString(), weekEnd: new Date(end + DAY_MS - 1).toISOString(), total: stories.length, previousTotal: previous.length, days: week.length,
    featured: stories.filter((item) => item.role === "featured").length, official: count("Official"), reported: count("Reported"), unconfirmed: count("Unconfirmed"),
    translated: stories.filter((item) => item.language).length,
    stories: stories.map(shown), top: top.map(shown), numbers, areas, radar: radarOf(week, ran),
  };
}


// ---- the Markdown the archive reads

const storiesOf = (count: number): string => `${count} ${count === 1 ? "story" : "stories"}`;
const trend = (count: number, previous: number): string => previous === 0 ? `${storiesOf(count)} this week, none last week`
  : count === previous ? `${storiesOf(count)} this week, the same as last week` : `${storiesOf(count)} this week, ${count > previous ? "up" : "down"} from ${previous} last week`;
/** "Reported · digitimes.com · translated from Chinese": where the claim comes from, as code printed it. */
export const tagOf = (item: { provenance: string; site: string; language: string | null }): string => `${item.provenance} · ${item.site}${item.language ? ` · translated from ${item.language}` : ""}`;

export function computeWeekMarkdown(edition: ComputeWeek): string {
  const { totals } = edition;
  const parts = [
    `# The week in AI compute: ${rangeLabel(edition.weekStart, edition.weekEnd)}`,
    `_${storiesOf(totals.stories)} in ${totals.days} daily ${totals.days === 1 ? "issue" : "issues"}: ${totals.official} official, ${totals.reported} reported, ${totals.unconfirmed} unconfirmed._`,
  ];
  const line = (item: ComputeItem) => `[${linkText(item.headline)}](${mdUrl(item.url)}) · ${mdText(tagOf(item))}`;
  if (edition.top.length) parts.push(`## Top of the week\n\n${edition.top.map((item, i) => `${i + 1}. ${line(item)}`).join("\n")}`);
  if (edition.numbers.length) {
    parts.push(`## By the numbers\n\n${edition.numbers.map((entry) => `- ${mdText(entry.fact)} “${mdText(entry.quote)}” · [${linkText(entry.headline)}](${mdUrl(entry.url)}) · ${mdText(tagOf(entry))}`).join("\n")}`);
  }
  for (const area of edition.areas) {
    const block = [`## ${area.area}`];
    if (area.overview) block.push(mdText(area.overview));
    if (area.items.length) block.push(area.items.map((item) => `- ${line(item)}`).join("\n"));
    block.push(`_${trend(area.count, area.previousCount)}._`);
    parts.push(block.join("\n\n"));
  }
  if (edition.radar.length) {
    parts.push(`## On the radar\n\nHeadlines collected that the daily issues had no place for, as the outlets wrote them.\n\n${edition.radar.map((item) => `- [${linkText(item.title)}](${mdUrl(item.url)}) · ${mdText(item.site)}`).join("\n")}`);
  }
  parts.push("_AI-generated: the stories and facts are the daily issues', the counts are computed, and prose is published only when it is found supported by the facts it rests on. No human edits it before it is sent._");
  return parts.join("\n\n") + "\n";
}

// ---- the run

export type WeeklyComputeJob = { date: string; now: string; publish: boolean };
export type WeeklyComputeDeps = { write: typeof writeOverviews; ground: typeof groundDrafts };
export type WeeklyComputeResult = { published: boolean; existing?: boolean; reason?: string; stories: number; areas: number; overviews: number; cost: number; preview: boolean; edition?: ComputeWeek };

const markerKey = (date: string) => `published/weekly-compute/${date}.json`;
const editionKey = (date: string) => `weekly-compute/${date}.json`;
const workKey = (date: string) => `weekly-compute/work/${date}.json`;
const summaryOf = (edition: ComputeWeek): Pick<WeeklyComputeResult, "stories" | "areas" | "overviews"> => ({ stories: edition.totals.stories, areas: edition.areas.length, overviews: edition.areas.filter(({ overview }) => overview).length });

export async function loadWeeklyCompute(date: string): Promise<ComputeWeek | null> {
  const saved = computeWeekSchema.safeParse(await readPrivateJson(editionKey(date)));
  return saved.success ? saved.data : null;
}

/** The published daily issues of the week ending on `date` and the week before it. An issue that was never published is not part of either. */
async function publishedIssues(date: string): Promise<IssueV2[]> {
  const from = dayStart(date) - 13 * DAY_MS;
  const days = (await listPrivateJsonKeys("published/daily/")).flatMap((key) => /(\d{4}-\d{2}-\d{2})\.json$/.exec(key)?.[1] ?? [])
    .filter((day) => dayStart(day) >= from && dayStart(day) <= dayStart(date));
  const issues: IssueV2[] = [];
  for (const day of [...new Set(days)].sort()) { const saved = await loadIssue(day); if (saved?.version === 2) issues.push(saved); }
  return issues;
}

export async function produceWeeklyCompute(steps: Steps, job: WeeklyComputeJob, deps: WeeklyComputeDeps): Promise<WeeklyComputeResult> {
  const { date } = job;
  const usage: Usage[] = [];
  const cost = () => usage.reduce((sum, entry) => sum + (entry.cost ?? 0), 0);

  const existing = await steps.run("existing", IO_STEP, async () => (await readPrivateJson(markerKey(date))) !== null ? await loadWeeklyCompute(date) : null);
  if (existing) return { published: true, existing: true, ...summaryOf(existing), cost: 0, preview: false };

  const planned = await steps.run("plan", IO_STEP, async () => {
    const plan = planComputeWeek(await publishedIssues(date), date);
    if (plan.total < MIN_STORIES) return { plan: false, total: plan.total };
    await writePrivateJson(workKey(date), plan);
    return { plan: true, total: plan.total };
  });
  if (!planned.plan) return { published: false, reason: "too few compute stories", stories: planned.total, areas: 0, overviews: 0, cost: 0, preview: !job.publish };

  const plan = (await readPrivateJson(workKey(date))) as ComputePlan;
  const wanted = plan.areas.filter(({ wantsOverview }) => wantsOverview);
  const writerTopic = (area: AreaPlan): WriterTopic => ({ topic: area.area, items: area.basis.map((item) => ({ headline: item.headline, facts: item.facts.slice(0, 2).map(({ fact }) => fact) })) });
  const evidenceOf = (area: AreaPlan) => area.basis.flatMap((item) => item.facts.slice(0, 2));
  const clean = (draft: OverviewDraft): string => cleanPunctuation(draft.overview).replace(/\s+/g, " ").trim();

  // ---- write, check, and repair once
  const drafts = new Map<Area, string>();
  if (wanted.length) {
    const written = await steps.run("write-0", MODEL_STEP, async () => deps.write(wanted.map(writerTopic)));
    usage.push(written.usage);
    for (const draft of written.drafts) if (wanted.some(({ area }) => area === draft.topic)) drafts.set(draft.topic as Area, clean(draft));
    const problemsOf = (area: AreaPlan) => overviewProblems(drafts.get(area.area) ?? "", evidenceOf(area));
    const broken = wanted.filter((area) => problemsOf(area).length);
    if (broken.length) {
      const problems = broken.flatMap((area) => problemsOf(area).map((problem) => `[${area.area}] ${problem}`));
      const repaired = await steps.run("repair", MODEL_STEP, async () => deps.write(broken.map(writerTopic), { drafts: broken.map((area) => ({ topic: area.area, overview: drafts.get(area.area) ?? "" })), problems }));
      usage.push(repaired.usage);
      for (const draft of repaired.drafts) if (broken.some(({ area }) => area === draft.topic)) drafts.set(draft.topic as Area, clean(draft));
    }
  }
  const sound = wanted.filter((area) => !overviewProblems(drafts.get(area.area) ?? "", evidenceOf(area)).length);

  // ---- ground: the first claim and the whole overview against the facts it rests on
  const grounded = sound.length ? await steps.run("ground", MODEL_STEP, async () => {
    const items: GroundItem[] = sound.map((area) => { const overview = drafts.get(area.area) ?? ""; return { id: area.area, headline: sentencesOf(overview)[0] ?? overview, summary: overview, facts: evidenceOf(area) }; });
    const result = await deps.ground(items);
    return { verdicts: [...result.verdicts], evaluator: result.evaluator, usage: result.usage };
  }) : { verdicts: [] as [string, SummaryVerdict][], evaluator: "none", usage: [] as Usage[] };
  usage.push(...grounded.usage);
  const verdicts = new Map(grounded.verdicts);

  // ---- assemble
  const areas: ComputeArea[] = plan.areas.map((area) => {
    const verdict = verdicts.get(area.area);
    const supported = !!verdict && verdict.headline.supported >= SIGNAL_GROUNDED && verdict.supported >= SIGNAL_GROUNDED && sound.includes(area);
    return { area: area.area, count: area.count, previousCount: area.previousCount, overview: supported ? drafts.get(area.area) ?? null : null, grounding: verdict ? { headline: verdict.headline.supported, summary: verdict.supported } : null, items: area.items };
  });
  const body = {
    version: 1 as const, date, weekStart: plan.weekStart, weekEnd: plan.weekEnd, generatedAt: job.now,
    totals: { stories: plan.total, featured: plan.featured, official: plan.official, reported: plan.reported, unconfirmed: plan.unconfirmed, translated: plan.translated, days: plan.days, previousStories: plan.previousTotal },
    top: plan.top, numbers: plan.numbers, areas, radar: plan.radar, evaluator: grounded.evaluator,
  };
  const edition = computeWeekSchema.parse({ ...body, markdown: computeWeekMarkdown({ ...body, markdown: "" }) });

  const published = await steps.run("publish", IO_STEP, async () => {
    if (!job.publish) return false;
    await createPrivateJson(editionKey(date), edition);
    await createPrivateJson(markerKey(date), { version: 2, kind: "weekly-compute", date, publishedAt: job.now });
    return true;
  });
  await steps.run("report", IO_STEP, async () => {
    await writePrivateJson(`weekly-compute/runs/${date}.json`, { version: 1, now: job.now, published, ...summaryOf(edition), cost: cost(), evaluator: grounded.evaluator, usage: usage.map(({ step, model, ms, inputTokens, outputTokens, cost: spent }) => ({ step, model, ms, inputTokens, outputTokens, cost: spent })) });
    await deletePrivateJson(workKey(date));
    return true;
  });
  return { published, ...summaryOf(edition), cost: cost(), preview: !job.publish, ...(job.publish ? {} : { edition }) };
}
