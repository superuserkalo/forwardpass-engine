import { z } from "zod";
import { issueV2Schema, loadIssue, markPublished, saveIssue, type IssueV2, type Usage } from "../lib/issue.js";
import { createPrivateJson, readPrivateJson } from "../lib/private-store.js";
import type { SignalService } from "../lib/signal-service.js";
import { attentionSchema, candidateSchema } from "../lib/schemas.js";
import { issueMarkdown, storyRecords, type StoryInput } from "./assemble.js";
import { clusterCandidates, COMPUTE_SLOTS, recentHeadlines, freshCandidates, loadWeightLog, publisherWeights, projectOf, sectionLabel, shortlistClusters, storyType, traction, type Cluster } from "./candidates.js";
import { computeMarks, isComputeCandidate } from "./compute.js";
import { translatedTraction } from "./language.js";
import { mayExcerpt, signalExcerpt } from "./excerpt.js";
import { pickStories, type EditorPick } from "./editor.js";
import { buildFactSheet, signalText, type FactSheet } from "./facts.js";
import { modelConfig } from "./models.js";
import { IO_STEP, MODEL_STEP, type Steps } from "./steps.js";
import { recallReport } from "./recall.js";
import { weeklyRecall } from "./recall-weekly.js";
import { rankTriaged, TRIAGE_BATCH, triageBatch, type ShortlistEntry, type TriageRow } from "./triage.js";
import {
  bannedSnippets, checkDraft, dropUnsupported, groundClaims, groundingProblems, cleanPunctuation, hasBannedPunctuation, headlineIssues, introIssues, lengthIssues, metaIssues, repairInstruction, scrubUngrounded,
  publishable, signalHeadline, signalIssues, ungroundedNumbers, writeParts, writerMaterial, writerText, writeSignals, type Parts, type Problem, type Signal, type SignalItem,
} from "./writing.js";

// The daily issue: the prototype's signal-first pipeline as durable steps.
// ~35 model calls, about four minutes, about $0.05 with the default models.

/** `compute` puts chip, memory and data center news in scope: shortlist slots so it reaches triage, a triage rubric for it, and the same editor and the same issue as every other story. Without it the issue is built as it always was. */
export type IssueJob = { date: string; now: string; publish: boolean; compute?: boolean };
/** Where the live signals are kept, so the recall report can count what was published as well as what the issue picked. Without it none are counted. */
export type IssueDeps = { signals?: Pick<SignalService, "recentHeadlines"> };
export type IssueResult = { date: string; status: "saved" | "existing"; published: boolean; subject: string; stories: number; cost: number };

const itemSchema = candidateSchema.extend({ host: z.string(), attention: z.array(attentionSchema).optional() });
const clusterSchema = z.object({ items: z.array(itemSchema), score: z.number(), lead: itemSchema });
const shortlistSchema = z.array(z.object({ id: z.string(), cluster: clusterSchema }));

const shortlistKey = (date: string) => `pipeline/issue/${date}/shortlist.json`;

async function loadShortlist(date: string): Promise<ShortlistEntry[]> {
  const value = await readPrivateJson(shortlistKey(date));
  if (value === null) throw new Error(`The shortlist for ${date} is missing.`);
  return shortlistSchema.parse(value);
}

export async function produceIssue(steps: Steps, job: IssueJob, deps: IssueDeps = {}): Promise<IssueResult> {
  const { date } = job;
  const now = new Date(job.now);
  const compute = job.compute === true;

  const existing = await steps.run("existing-issue", IO_STEP, async () => {
    const saved = await loadIssue(date);
    return saved ? { subject: saved.version === 2 ? saved.subject : `The Forward Pass — ${date}`, stories: saved.version === 2 ? saved.stories.length : 0 } : null;
  });
  if (existing) {
    const published = job.publish && await steps.run("publish", IO_STEP, async () => { await markPublished(date, new Date().toISOString()); return true; });
    return { date, status: "existing", published, subject: existing.subject, stories: existing.stories, cost: 0 };
  }

  // Stage 1: fresh candidates, clusters and the shortlist, with no model calls.
  const stage1 = await steps.run("candidates", IO_STEP, async () => {
    const fresh = await freshCandidates(date, now);
    if (!fresh.candidates.length) throw new Error(`No fresh candidates since ${fresh.since}; check collection before retrying.`);
    const clusters = clusterCandidates(fresh.candidates, publisherWeights(await loadWeightLog(), date));
    const shortlist = shortlistClusters(clusters, undefined, undefined, undefined, compute ? COMPUTE_SLOTS : 0).map((cluster, i) => ({ id: `c${i}`, cluster }));
    await createPrivateJson(shortlistKey(date), shortlist);
    console.info("forwardpass.candidates", JSON.stringify({ date, candidates: fresh.candidates.length, clusters: clusters.length, shortlisted: shortlist.length, since: fresh.since, previousIssue: fresh.previousIssue, snapshots: fresh.snapshots }));
    return { candidates: fresh.candidates.length, clusters: clusters.length, shortlisted: shortlist.length, since: fresh.since, previousIssue: fresh.previousIssue };
  });

  // Stage 2: triage in parallel batches. A batch that keeps failing is left out rather than stopping the issue.
  const batches = Math.ceil(stage1.shortlisted / TRIAGE_BATCH);
  const triaged = await Promise.all(Array.from({ length: batches }, async (_, b) => {
    try {
      return await steps.run(`triage-${b}`, MODEL_STEP, async () => triageBatch((await loadShortlist(date)).slice(b * TRIAGE_BATCH, (b + 1) * TRIAGE_BATCH), compute));
    } catch (error) {
      console.warn("forwardpass.triage_batch_failed", JSON.stringify({ date, batch: b, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
      return { rows: [] as TriageRow[], usage: null };
    }
  }));
  const rows = triaged.flatMap(({ rows }) => rows);
  if (!rows.length) throw new Error("Every triage batch failed.");

  // Stage 3: one editor call picks 3 featured stories and 6 signals.
  const editor = await steps.run("editor", MODEL_STEP, async () => pickStories(rankTriaged(rows, await loadShortlist(date)), await loadShortlist(date), { compute, recent: compute ? await recentHeadlines(date) : [] }));
  const pick: EditorPick = editor.pick;

  // Stage 4: a fact sheet per featured story, in parallel.
  const factSheets = await Promise.all(pick.featured.map((url, i) => steps.run(`facts-${i}`, MODEL_STEP, async () => {
    const shortlist = await loadShortlist(date);
    const cluster = clusterFor(shortlist, url);
    // Triage 9-10 marks a frontier model or major platform launch: the story is the launch, not a spec.
    const id = shortlist.find((entry) => entry.cluster.lead.url === url)?.id;
    const row = rows.find((r) => r.id === id);
    return buildFactSheet(date, cluster, sectionLabel(url), (row?.importance ?? 0) >= 9, compute);
  })));
  const sheets: FactSheet[] = factSheets.map(({ sheet }) => sheet);

  // Stage 5a: signal headlines from each signal's page text, checked in code, one repair.
  const signalStep = await steps.run("signals", MODEL_STEP, async () => {
    const shortlist = await loadShortlist(date);
    const items: SignalItem[] = await Promise.all(pick.signals.map(async (url, i) => {
      const cluster = clusterFor(shortlist, url);
      // A compute story among the signals is written and checked like the rest, and told apart by code so its headline keeps a report's hedge.
      const lane = compute && isComputeCandidate(cluster.lead);
      return { id: `s${i + 1}`, title: cluster.lead.title, project: projectOf(cluster), source: cluster.lead.source, url, summary: cluster.lead.summary.slice(0, 600), text: await signalText(date, url),
        ...(lane ? { lane: "compute" as const, via: { source: cluster.lead.source, category: cluster.lead.category } } : {}) };
    }));
    const usage: Usage[] = [];
    let { signals, usage: first } = await writeSignals(items);
    usage.push(first);
    const firstIssues = signalIssues(items, signals);
    if (firstIssues.length) {
      const repaired = await writeSignals(items, firstIssues, signals);
      signals = repaired.signals;
      usage.push(repaired.usage);
    }
    // An item in another language with no English headline of its own is left out here, before the draft is written and checked: the checker
    // numbers the signals by position, and its fixes go back to the item with that number.
    const kept = publishable(items, signals);
    return { items: kept.items, signals: kept.signals, firstIssues, finalIssues: signalIssues(kept.items, kept.signals), usage };
  });
  const headlinesFor = (signals: Signal[]) => signalStep.items.map((item) => signalHeadline(item, signals));

  // Stage 5b: the writer returns the issue's parts; code checks them and one model checks for misleading claims.
  const evidence = sheets.map(({ title, facts, tryIt, alsoAvailableOn }) => ({ title, facts: facts.map(({ fact, quote }) => ({ fact, quote })), tryIt, alsoAvailableOn }));
  const material = writerMaterial(date, sheets, headlinesFor(signalStep.signals));
  const written = await steps.run("write", MODEL_STEP, async () => writeParts(material));
  const checked = await steps.run("check", MODEL_STEP, async () => checkDraft(material, signalStep.items, written.parts));
  // JEV scores every prose sentence; ones the free-text check did not already flag join the repair.
  const grounded = await steps.run("ground", MODEL_STEP, async () => groundClaims(evidence, written.parts));
  const groundProblems = groundingProblems(grounded.results).filter((g) => !checked.problems.some((p) => p.text.includes(g.text) || g.text.includes(p.text)));
  const firstChecks = {
    ungrounded: ungroundedNumbers(written.parts, material), headlines: headlineIssues(written.parts, sheets), intro: introIssues(written.parts),
    lengths: lengthIssues(written.parts, sheets), punctuation: bannedSnippets(writerText(written.parts)), meta: metaIssues(written.parts), misleading: [...checked.problems, ...groundProblems],
  };
  const repair = await steps.run("repair", MODEL_STEP, async () => repairDraft(material, signalStep.items, signalStep.signals, written.parts, sheets, firstChecks));

  const regrounded = await steps.run("ground-final", MODEL_STEP, async () => groundClaims(evidence, repair.parts, "ground-final"));

  // Stage 6: code assembles, guards and saves the issue.
  const saved = await steps.run("assemble", IO_STEP, async () => {
    const shortlist = await loadShortlist(date);
    const finalMaterial = { ...material, signalHeadlines: headlinesFor(repair.signals) };
    const dropped = dropUnsupported(repair.parts, regrounded.results);
    const scrubbed = scrubUngrounded(dropped.parts, finalMaterial);
    const parts: Parts = {
      preview: cleanPunctuation(scrubbed.parts.preview), intro: scrubbed.parts.intro.map((p) => cleanPunctuation(p.trim())),
      featured: scrubbed.parts.featured.map(({ headline, body }) => ({ headline: cleanPunctuation(headline.trim()), body: cleanPunctuation(body.trim()) })),
    };
    const topicsFor = (url: string) => rows.find((row) => shortlist.find(({ id }) => id === row.id)?.cluster.lead.url === url)?.topics ?? [];
    // A compute story is an ordinary story, featured or a signal. What marks it is where its claim comes from, shown where an attention number would
    // be, and a compute topic. Whether a story is compute is decided in code on the page that would be shown.
    const marked = (input: StoryInput, cluster: Cluster, text: string | undefined): StoryInput => {
      const marks = compute ? computeMarks({ lead: cluster.lead, text, traction: input.traction, topics: input.topics }) : null;
      if (marks) return { ...input, ...marks };
      // A story read in another language says so whether or not it is about compute.
      const traction = translatedTraction(cluster.lead, input.traction);
      return traction === input.traction ? input : { ...input, traction };
    };
    const featured: StoryInput[] = sheets.map((sheet, i) => {
      const cluster = clusterFor(shortlist, sheet.url);
      return marked({ role: "featured", label: sheet.label, type: storyType(sheet.url), headline: parts.featured[i]?.headline || sheet.title, body: parts.featured[i]?.body ?? null,
        url: sheet.url, sources: sheet.sources, traction: traction(cluster), topics: topicsFor(sheet.url), project: projectOf(cluster),
        publishedAt: cluster.lead.publishedAt, facts: sheet.facts }, cluster, sheet.facts.map(({ fact, quote }) => `${fact} ${quote}`).join(" "));
    });
    const signals: StoryInput[] = signalStep.items.flatMap((item) => {
      const headline = cleanPunctuation(signalHeadline(item, repair.signals));
      if (!headline) return [];
      const cluster = clusterFor(shortlist, item.url);
      // The source's own description, for a reader's own edition to lead with. Nothing here is written by a model.
      const excerpt = mayExcerpt(cluster.lead) ? signalExcerpt(item.summary, headline) : null;
      return [marked({ role: "signal", label: "Signal", type: storyType(item.url), headline, body: null, ...(excerpt ? { excerpt } : {}),
        url: item.url, sources: [item.url], traction: traction(cluster), topics: topicsFor(item.url), project: projectOf(cluster),
        publishedAt: cluster.lead.publishedAt, facts: [] }, cluster, item.text ?? undefined)];
    });
    const stories = storyRecords(date, featured, signals);
    const usage = [...triaged.flatMap(({ usage }) => usage ? [usage] : []), ...editor.usage, ...factSheets.flatMap(({ usage }) => usage),
      ...signalStep.usage, written.usage, checked.usage, ...repair.usage,
      ...[grounded.usage, regrounded.usage].filter((u): u is Usage => !!u)];
    const draft: Omit<IssueV2, "markdown"> = {
      version: 2, date, createdAt: now.toISOString(), subject: stories[0].headline, preview: parts.preview, intro: parts.intro, stories,
      pipeline: {
        candidates: stage1.candidates, clusters: stage1.clusters, shortlisted: stage1.shortlisted, kept: rankTriaged(rows, shortlist).length,
        models: modelConfig(), usage,
        checks: { since: stage1.since, previousIssue: stage1.previousIssue, editorRationale: pick.rationale, filledPicks: pick.filled,
          first: firstChecks, final: repair.finalChecks, scrubbed: scrubbed.removed, unsupported: dropped.removed,
          grounding: { evaluator: grounded.evaluator, first: grounded.results.filter(({ supported }) => supported < 0.5).length, final: regrounded.results.filter(({ supported }) => supported < 0.5).map(({ claim, supported, verdict, confidence }) => ({ text: claim.text, verdict, supported, confidence })) }, signalIssues: { first: signalStep.firstIssues, final: repair.finalSignalIssues },
          evaluators: sheets.map(({ evaluator }) => evaluator), droppedFacts: sheets.map(({ dropped }) => dropped), captureFallbacks: sheets.filter(({ fallback }) => fallback).map(({ url }) => url),
          ...(compute ? { compute: {
            lane: shortlist.filter(({ cluster }) => isComputeCandidate(cluster.lead)).length, rows: rankTriaged(rows, shortlist).filter((row) => row.section === "compute").length,
            // The compute stories in the issue and where each claim comes from, and what triage ranked highest as compute, so a day's picks can be judged against the alternatives.
            placed: stories.filter(({ traction: tag }) => /^(?:Official|Reported|Unconfirmed) · /.test(tag ?? "")).map(({ role, traction: tag }) => ({ role, tag: tag?.split(" · ")[0] })),
            pool: rankTriaged(rows, shortlist).filter((row) => row.section === "compute").slice(0, 15).flatMap((row) => {
              const entry = shortlist.find(({ id }) => id === row.id);
              return entry ? [{ url: entry.cluster.lead.url, title: entry.cluster.lead.title, importance: row.importance }] : [];
            }),
          } } : {}) },
      },
    };
    const issue = issueV2Schema.parse({ ...draft, markdown: issueMarkdown(draft) });
    if (hasBannedPunctuation(issue.markdown)) throw new Error("An em dash or semicolon survived the final guard.");
    await saveIssue(issue);
    const cost = usage.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
    console.info("forwardpass.issue_saved", JSON.stringify({ date, subject: issue.subject, stories: stories.length, calls: usage.length, cost }));
    return { subject: issue.subject, stories: stories.length, cost };
  });

  const published = job.publish && await steps.run("publish", IO_STEP, async () => { await markPublished(date, new Date().toISOString()); return true; });
  // Recall against AlphaSignal is a report, never a gate: a failure here does not affect the issue.
  if (!process.env.SKIP_RECALL) try {
    await steps.run("recall", MODEL_STEP, async () => {
      const shortlist = await loadShortlist(date);
      return (await recallReport(date, now, shortlist, rankTriaged(rows, shortlist), [...pick.featured, ...pick.signals], { signals: deps.signals })).counts;
    });
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) await steps.run("recall-weekly", IO_STEP, async () => (await weeklyRecall(date)).totals);
  } catch (error) {
    console.warn("forwardpass.recall_failed", JSON.stringify({ date, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
  }
  return { date, status: "saved", published, ...saved };
}

function clusterFor(shortlist: ShortlistEntry[], url: string): Cluster {
  const entry = shortlist.find(({ cluster }) => cluster.lead.url === url);
  if (!entry) throw new Error(`Picked story ${url} is not in the shortlist.`);
  return entry.cluster;
}

type Checks = { ungrounded: string[]; headlines: string[]; intro: string[]; lengths: string[]; punctuation: string[]; meta: string[]; misleading: Problem[] };

async function repairDraft(material: ReturnType<typeof writerMaterial>, items: SignalItem[], signals: Signal[], parts: Parts, sheets: FactSheet[], checks: Checks) {
  const usage: Usage[] = [];
  let nextSignals = signals;
  // Signal lines come from their own call, so their problems go back to that call.
  const signalProblems = checks.misleading.filter((problem) => problem.where === "signal" && problem.signal);
  if (signalProblems.length) {
    const repaired = await writeSignals(items, signalProblems.map((p) => `s${p.signal}: ${p.why} Fix: ${p.fix}`), signals);
    nextSignals = repaired.signals;
    usage.push(repaired.usage);
  }
  const writerProblems = checks.misleading.filter((problem) => problem.where !== "signal");
  let nextParts = parts;
  if (checks.ungrounded.length || writerProblems.length || checks.headlines.length || checks.intro.length || checks.lengths.length || checks.punctuation.length || checks.meta.length || parts.featured.length !== sheets.length) {
    const repaired = await writeParts({ ...material, signalHeadlines: items.map((item) => signalHeadline(item, nextSignals)) }, {
      previous: parts, instruction: repairInstruction(sheets.length, checks.ungrounded, writerProblems, checks.headlines, checks.intro, checks.lengths, checks.punctuation, checks.meta),
    });
    // A repair that loses a featured story is worse than the draft it repairs.
    if (repaired.parts.featured.length === sheets.length) nextParts = repaired.parts;
    usage.push(repaired.usage);
  }
  const finalChecks = { ungrounded: ungroundedNumbers(nextParts, material), headlines: headlineIssues(nextParts, sheets), intro: introIssues(nextParts), lengths: lengthIssues(nextParts, sheets), punctuation: bannedSnippets(writerText(nextParts)), meta: metaIssues(nextParts) };
  return { parts: nextParts, signals: nextSignals, usage, finalChecks, finalSignalIssues: signalIssues(items, nextSignals) };
}
