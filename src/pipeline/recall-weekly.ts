import { z } from "zod";
import { listPrivateJsonKeys, readPrivateJson, writePrivateJson } from "../lib/private-store.js";
import { hostOf, knownHosts, loadRegistry } from "../lib/source-discovery.js";
import { publisherDomain } from "./publisher-domain.js";
import { emptyCounts } from "./recall-match.js";
import type { RecallStage } from "./recall.js";

// Weekly view of the recall loop: is the gap to AlphaSignal closing, and which publishers do we
// still miss after discovery and the learned weights have had their chance?

const reportSchema = z.object({
  date: z.iso.date(), benchmark: z.number(), counts: z.record(z.string(), z.number()),
  stories: z.array(z.object({ alphasignal: z.string(), stage: z.string(), sources: z.array(z.string()).default([]) })),
});

export type WeeklyRecall = {
  week: string; days: string[];
  daily: { date: string; benchmark: number; reached: number; published: number; picked: number }[];
  totals: Record<RecallStage, number>;
  stillMissing: { domain: string; stories: number; covered: "catalog" | "discovered" | "no"; example: string }[];
};

export async function weeklyRecall(date: string): Promise<WeeklyRecall> {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const keys = (await listPrivateJsonKeys("reports/recall/")).filter((key) => /\/\d{4}-\d{2}-\d{2}\.json$/.test(key)).sort();
  const reports = [];
  for (const key of keys) {
    const day = key.slice(-15, -5);
    if (day >= from && day <= date) reports.push(reportSchema.parse(await readPrivateJson(key)));
  }
  const totals = emptyCounts();
  const misses = new Map<string, { stories: number; example: string }>();
  for (const report of reports) {
    for (const story of report.stories) {
      const stage = story.stage as RecallStage;
      if (stage in totals) totals[stage]++;
      if (stage !== "missing" && stage !== "collected") continue;
      const host = story.sources.map(hostOf).find((h): h is string => !!h && !/(^|\.)(github\.com|huggingface\.co|arxiv\.org)$/.test(h));
      if (!host) continue;
      const domain = publisherDomain(host);
      const row = misses.get(domain) ?? { stories: 0, example: story.alphasignal };
      row.stories++;
      misses.set(domain, row);
    }
  }
  const known = knownHosts();
  const registry = await loadRegistry();
  const covered = (domain: string): "catalog" | "discovered" | "no" =>
    [...known].some((k) => k === domain || k.endsWith(`.${domain}`)) ? "catalog"
      : ["probation", "active"].includes(registry.sources[domain]?.status ?? "") ? "discovered" : "no";
  const summary: WeeklyRecall = {
    week: `${from}..${date}`, days: reports.map(({ date }) => date),
    daily: reports.map((r) => ({ date: r.date, benchmark: r.benchmark, reached: r.benchmark - (r.counts.missing ?? 0), published: r.counts.published ?? 0, picked: r.counts.picked ?? 0 })),
    totals,
    stillMissing: [...misses].sort((a, b) => b[1].stories - a[1].stories).slice(0, 25).map(([domain, row]) => ({ domain, stories: row.stories, covered: covered(domain), example: row.example })),
  };
  await writePrivateJson(`reports/recall/weekly-${date}.json`, summary);
  console.info("forwardpass.recall_weekly", JSON.stringify({ week: summary.week, totals, uncovered: summary.stillMissing.filter((m) => m.covered === "no").length }));
  return summary;
}
