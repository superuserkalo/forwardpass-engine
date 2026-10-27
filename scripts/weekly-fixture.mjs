import { signalId } from "../src/lib/signals.ts";
import { weeklyEditionSchema } from "../src/pipeline/weekly.ts";

// A week with three busy topics, one with an overview the judge did not support, and one that was quiet.
export const NOW = new Date("2026-10-11T06:30:00.000Z");
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
export const item = (n, extra = {}) => ({ id: signalId(`https://pub${n}.test/post`), headline: `Pub ${n} ships thing ${n} for developers`, summary: `Thing ${n} shipped. It does a useful thing.`, url: `https://pub${n}.test/post`, publisher: `Pub ${n}`, importance: 7, publishedAt: ago(1), facts: [{ fact: `Pub ${n} shipped thing ${n} on Tuesday.`, quote: `shipped thing ${n}` }, { fact: `Thing ${n} runs locally.`, quote: `runs locally` }], ...extra });
export const topic = (name, count, extra = {}) => ({ topic: name, count, previousCount: count - 2, publishers: [{ name: "Pub 1", count: 2 }], overview: `${name} moved this week. Several launches are listed below.`, grounding: { headline: 0.9, summary: 0.85 }, items: [item(1), item(2)], ...extra });
export const EDITION = () => weeklyEditionSchema.parse({
  version: 1, date: "2026-10-11", weekStart: ago(7), weekEnd: NOW.toISOString(), generatedAt: NOW.toISOString(), totals: { signals: 40, topics: 4, previousSignals: 30 }, evaluator: "jev",
  top: [item(10, { importance: 9 }), item(11, { importance: 9 }), item(12, { importance: 8 })],
  topics: [topic("Agents", 20), topic("Retrieval", 10), topic("Security", 6, { overview: null, grounding: { headline: 0.9, summary: 0.4 }, items: [item(3)] }), topic("Video", 4, { previousCount: 0, items: [] })],
  markdown: "# The week in AI engineering: 4 to 11 October\n",
});
