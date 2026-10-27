import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { signalId } from "../src/lib/signals.ts";
import { overviewProblems, planWeek, produceWeekly, weeklyEditionSchema, weeklyMarkdown, writeOverviews } from "../src/pipeline/weekly.ts";
import { newStore, record } from "./signals-test-support.mjs";

// The weekly research is written once per topic and assembled per reader. Its numbers are code, its items are verified signals, and
// the prose between them is published only if the judge finds it supported by the facts it rests on.
const NOW = new Date("2026-10-11T06:30:00.000Z");
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const sig = (n, extra = {}) => ({
  id: signalId(`https://pub${n}.test/post`), headline: `Signal ${n} headline about a release this week`, summary: `Signal ${n} summary. It has a second sentence.`, type: "news", topics: ["Agents"], publisher: `Pub ${n}`,
  publishedAt: ago(1), sourcePublishedAt: ago(1.1), traction: null, importance: 6, url: `https://pub${n}.test/post`, status: "live", evidenceCount: 2, ...extra,
});

// ---- the plan

test("the plan counts what each topic had this week and the week before, ranks what mattered, and picks the week's top across topics", () => {
  const signals = [
    ...Array.from({ length: 10 }, (_, i) => sig(i, { topics: ["Agents"], importance: 4 + (i % 6), publisher: `Pub ${i % 5}` })),
    ...Array.from({ length: 4 }, (_, i) => sig(100 + i, { topics: ["Retrieval", "Agents"], importance: 7, publishedAt: ago(2 + i) })),
    ...Array.from({ length: 5 }, (_, i) => sig(200 + i, { topics: ["Agents"], publishedAt: ago(8 + i) })),
    ...Array.from({ length: 3 }, (_, i) => sig(400 + i, { topics: ["Agents"], importance: 9.5, publisher: "Big Lab", publishedAt: ago(0.5 + i * 0.1) })),
    sig(410, { topics: ["Agents"], importance: 10, publishedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }),
    sig(300, { topics: ["Security"], importance: 3 }),
    sig(301, { topics: ["Security"], importance: 9, status: "retracted" }),
    sig(302, { topics: ["Security"], importance: 9, publishedAt: ago(20) }),
  ];
  const plan = planWeek(signals, NOW);
  assert.deepEqual([plan.weekStart, plan.weekEnd], [ago(7), NOW.toISOString()]);
  assert.deepEqual([plan.total, plan.previousTotal], [17, 5], "importance 4 and over, not retracted, not from the future, this week or last");
  const agents = plan.topics.find(({ topic }) => topic === "Agents");
  assert.deepEqual([agents.count, agents.previousCount], [17, 5], "a signal with two topics counts in both");
  assert.equal(plan.topics.find(({ topic }) => topic === "Retrieval").count, 4);
  assert.equal(plan.topics.find(({ topic }) => topic === "Security"), undefined, "nothing eligible, no topic");
  assert.deepEqual(plan.topics.map(({ topic }) => topic), ["Agents", "Retrieval"], "busiest first");
  assert.ok(agents.basis.length === 8 && agents.shown.length === 6);
  assert.ok(agents.basis.every((item, i) => i === 0 || agents.basis[i - 1].importance >= item.importance), "most important first");
  assert.equal(plan.top.length, 5);
  assert.ok(plan.top.every((item, i) => i === 0 || plan.top[i - 1].importance >= item.importance));
  assert.ok(Object.values(plan.top.reduce((counts, item) => ({ ...counts, [item.publisher]: (counts[item.publisher] ?? 0) + 1 }), {})).every((n) => n <= 2), "no publisher more than twice");
  assert.equal(plan.top.filter((item) => item.publisher === "Big Lab").length, 2, "three of the five most important were one publisher's, and two are shown");
  assert.deepEqual(agents.publishers.map(({ name }) => name).length, 3);
  assert.ok(agents.publishers[0].count >= agents.publishers[1].count);
});

test("a topic that had only a little has its items but not an overview, and the plan does not depend on the order it was given", () => {
  const signals = [sig(1, { topics: ["Audio"] }), sig(2, { topics: ["Audio"] }), ...Array.from({ length: 3 }, (_, i) => sig(10 + i, { topics: ["Video"] })), sig(20, { topics: ["Data"] }), sig(21, { topics: ["Data"] })];
  const plan = planWeek(signals, NOW);
  assert.deepEqual(plan.topics.map(({ topic, wantsOverview }) => [topic, wantsOverview]), [["Video", true], ["Audio", false], ["Data", false]], "busiest first, then by name");
  assert.deepEqual(planWeek([...signals].reverse(), NOW), plan);
});

// ---- the checks on an overview

test("an overview is plain, short, about the facts it was given and no others", () => {
  const facts = [{ fact: "Haiku 5.5 costs 90% less than Haiku 4.5.", quote: "priced 90% lower" }, { fact: "GPT-6 starts answering 44% sooner.", quote: "44% sooner" }];
  const problems = (text) => overviewProblems(text, facts);
  assert.deepEqual(problems("Anthropic cut the price of Haiku by 90%. OpenAI made GPT-6 answer 44% sooner."), []);
  assert.ok(problems("Anthropic cut the price of Haiku by 80%.").some((p) => /80/.test(p)), "a number no fact states");
  assert.ok(problems("Prices fell; speed rose.").some((p) => /semicolon|dash/i.test(p)));
  assert.ok(problems("Prices fell — speed rose.").some((p) => /semicolon|dash/i.test(p)));
  assert.ok(problems("See https://evil.example for more.").some((p) => /link|markup/i.test(p)));
  assert.ok(problems("The post does not say what it costs.").some((p) => /commentary|source/i.test(p)));
  assert.ok(problems("One. Two sentences here. Three of them now. And a fourth one too.").some((p) => /sentence/i.test(p)));
  assert.ok(problems(Array.from({ length: 100 }, () => "word").join(" ") + ".").some((p) => /words/i.test(p)));
  assert.ok(problems("").some((p) => /overview/i.test(p)));
  assert.ok(problems("Too short.").some((p) => /short/i.test(p)));
  assert.deepEqual(problems("A year like 2026 is not a claim, and neither is a version like Haiku 5.5."), []);
  for (const problem of problems("Prices fell by 80%; see https://evil.example. The post does not say.")) assert.ok(!/evil\.example|80%/.test(problem), "a problem names the defect and never repeats the text");
});

// ---- the markdown the website reads

const edition = () => weeklyEditionSchema.parse({
  version: 1, date: "2026-10-11", weekStart: ago(7), weekEnd: NOW.toISOString(), generatedAt: NOW.toISOString(), totals: { signals: 14, topics: 2, previousSignals: 5 }, evaluator: "jev",
  top: [{ id: signalId("https://pub1.test/post"), headline: "Anthropic cuts Haiku 5.5 prices by 90%", summary: "Haiku 5.5 costs 90% less. It is available now.", url: "https://pub1.test/post", publisher: "Anthropic", importance: 9, publishedAt: ago(1), facts: [{ fact: "Haiku 5.5 costs 90% less than Haiku 4.5.", quote: "priced 90% lower" }] }],
  topics: [
    { topic: "Agents", count: 14, previousCount: 5, publishers: [{ name: "Anthropic", count: 3 }], overview: "Agent tooling moved from demos to defaults this week. Anthropic cut Haiku prices by 90%.", grounding: { headline: 0.9, summary: 0.8 }, items: [{ id: signalId("https://pub2.test/post"), headline: "Warp adds [Teams] support", summary: "Warp adds Teams.", url: "https://pub2.test/post", publisher: "Warp", importance: 6, publishedAt: ago(2), facts: [{ fact: "Teams works with Factories.", quote: "Teams" }] }] },
    { topic: "Retrieval", count: 4, previousCount: 0, publishers: [], overview: null, grounding: null, items: [] },
  ],
  markdown: "x",
});

test("the edition reads as the website's weekly format: a title, a lead, takeaways, then a section for the top and one for each topic", () => {
  const md = weeklyMarkdown(edition());
  const lines = md.split("\n");
  assert.equal(lines[0], "# The week in AI engineering: 4 to 11 October");
  assert.match(md, /\n_14 verified signals across 2 topics\./);
  assert.match(md, /\n- Anthropic cuts Haiku 5\.5 prices by 90%\n/, "the top headline as a takeaway");
  assert.deepEqual(lines.filter((line) => line.startsWith("## ")), ["## Top of the week", "## Agents", "## Retrieval"]);
  assert.match(md, /Agent tooling moved from demos to defaults this week\./);
  assert.match(md, /\[Warp adds \(Teams\) support\]\(https:\/\/pub2\.test\/post\)/, "brackets in a headline cannot break the link");
  assert.match(md, new RegExp(`https://theforwardpass\\.net/signals/${signalId("https://pub2.test/post")}`), "each item links to its evidence");
  assert.match(md, /14 signals this week, up from 5 last week/);
  assert.match(md, /AI-generated/);
});

test("what the Markdown is given is text, never Markdown: a headline, a fact, a publisher, an overview and an address cannot add a link, an image, a heading or emphasis", () => {
  const hostile = edition();
  const evil = "https://evil.example/p.png";
  hostile.top[0] = { ...hostile.top[0], headline: `Fine headline](${evil}) and *bold* and _under_ and \`code\` and <b>tag</b>`, publisher: "Pub_with_*marks*", url: `https://pub1.test/a)![x](${evil})` , summary: `A summary with ![pixel](${evil}) and [link](${evil}).` };
  hostile.topics[0] = {
    ...hostile.topics[0], overview: `# A heading from a model. > And a quote. [link](${evil}) done`,
    items: [{ ...hostile.topics[0].items[0], headline: "Item [one](x) *bold*", publisher: "Pub*", url: "https://pub2.test/with space/(parens)", facts: [{ fact: `# Not a heading, but a fact with ![img](${evil}) in it.`, quote: "q" }] }],
  };
  hostile.topics[0].publishers = [{ name: "Under_score*Star", count: 3 }];
  const md = weeklyMarkdown(hostile);
  assert.doesNotMatch(md, /!\[/, "no image can be made");
  const destinations = [...md.matchAll(/(?<!\\)\]\(([^)\s]*)\)/g)].map(([, url]) => url);
  assert.ok(destinations.length > 0);
  for (const url of destinations) assert.match(url, /^https:\/\/(?:pub[12]\.test|theforwardpass\.net)\//, `a link goes where the edition says: ${url}`);
  assert.ok(!destinations.some((url) => url.startsWith("https://evil")), "and never to what a headline or a summary contained");
  assert.doesNotMatch(md, /(?<!\\)[<>]/, "no angle bracket passes as markup: each is escaped");
  assert.ok(!/^(?:#{1,6} (?!The week|Top of|Agents|Retrieval)|> )/m.test(md), "no line becomes a heading or a quote because of what a model wrote");
  assert.doesNotMatch(md, /(?<![\\])\*[^*\n]*bold[^*\n]*\*(?!\*)/, "emphasis a headline asked for is escaped");
  assert.match(md, /Pub\\_with\\_\\\*marks\\\*/, "a publisher's marks are shown, as characters");
  assert.ok(md.includes("https://pub2.test/with%20space/%28parens%29"), "an address is percent-encoded where Markdown would read it");
  assert.equal(md.split("\n").filter((line) => line.startsWith("## ")).length, 3, "the three headings the edition has, and no other");
  assert.match(md, /Most from Under\\_score\\\*Star\./, "publisher names in the closing line are text too");
  assert.match(md, /\\# Not a heading, but a fact/, "a fact that begins like a heading is shown as text");
});

test("the closing line of a topic in the Markdown names its publishers only when one of them published more than once", () => {
  const base = edition();
  base.topics[0].publishers = [{ name: "Solo A", count: 1 }, { name: "Solo B", count: 1 }];
  assert.doesNotMatch(weeklyMarkdown(base), /Most from/);
  base.topics[0].publishers = [{ name: "Busy", count: 2 }, { name: "Solo", count: 1 }];
  assert.match(weeklyMarkdown(base), /Most from Busy\./);
});

test("an address that is not a web address is not a link, whatever the edition holds", () => {
  const odd = edition();
  odd.top[0] = { ...odd.top[0], url: "javascript:alert(1)" };
  odd.topics[0].items = [{ ...odd.topics[0].items[0], url: "data:text/html,<script>x</script>" }, { ...odd.topics[0].items[0], url: "not a url at all" }];
  const md = weeklyMarkdown(odd);
  assert.doesNotMatch(md, /javascript:|data:text|not a url/);
  assert.equal([...md.matchAll(/\]\(#\)/g)].length, 3, "each becomes an inert anchor");
});

test("an edition whose items hold an address that is not https is not an edition", () => {
  const bad = JSON.parse(JSON.stringify(edition()));
  bad.top[0].url = "javascript:alert(1)";
  assert.equal(weeklyEditionSchema.safeParse(bad).success, false);
  bad.top[0].url = "http://pub.test/plain";
  assert.equal(weeklyEditionSchema.safeParse(bad).success, false);
});

// ---- the whole run

const FACTS = (n) => [{ fact: `Pub ${n} shipped thing ${n} on Tuesday.`, quote: `shipped thing ${n}`, impact: 3 }, { fact: `Thing ${n} costs ${n + 10} dollars.`, quote: `costs ${n + 10} dollars`, impact: 2 }];

async function world(count = 14, topics = ["Agents"]) {
  useStore(memoryStore({}));
  const service = localSignalService(newStore());
  // One signal whose five facts were stored from the least to the most telling.
  await service.publish(record("https://pub.test/deep", { headline: "Deep Lab ships a thing with five verified facts today", summary: "Deep thing shipped. It has five facts.", topics, importance: 10, publisher: "Deep Lab", publishedAt: ago(0.5), facts: [1, 2, 3, 4, 5].map((n) => ({ fact: `Deep fact number ${n} is stated here.`, quote: `fact number ${n}`, impact: n })) }));
  for (let i = 0; i < count; i++) await service.publish(record(`https://pub${i}.test/post`, { headline: `Pub ${i} ships thing ${i} for developers this week`, summary: `Thing ${i} shipped. It costs ${i + 10} dollars.`, topics, importance: 5 + (i % 5), publisher: `Pub ${i % 6}`, publishedAt: ago(1 + (i % 5) * 0.5), facts: FACTS(i).map(({ fact, quote, impact }) => ({ fact, quote, impact })) }));
  return service;
}
const steps = (names = []) => ({ run: async (name, config, callback) => { names.push(name); return JSON.parse(JSON.stringify(await callback())); }, sleep: async () => {} });
const usage = (step) => ({ step, model: "test", ms: 1, inputTokens: 10, outputTokens: 5, cost: 0.002 });
function models(overrides = {}) {
  const calls = { write: [], ground: [] };
  return { calls, deps: {
    write: async (topics, previous) => {
      calls.write.push({ topics: topics.map(({ topic }) => topic), repair: !!previous, problems: previous?.problems ?? [], payload: topics });
      return { drafts: topics.map(({ topic }) => ({ topic, overview: overrides.overview?.(topic, !!previous) ?? "Developers shipped many things this week. Several launches are listed below." })), usage: usage("write") };
    },
    ground: async (items) => {
      calls.ground.push(items.map(({ id, headline, summary }) => ({ id, headline, summary })));
      const judged = { verdict: "supported", supported: 0.9, confidence: 0.9 };
      return { verdicts: new Map(items.map((item) => [item.id, { ...judged, headline: { ...judged, ...(overrides.headline?.(item) ?? {}) }, fact: { text: item.facts[0].fact, supported: 0.9 }, sentences: [], ...(overrides.verdict?.(item) ?? {}) }])), evaluator: "jev", usage: [usage("ground")] };
    },
  } };
}
const run = (service, mocks, job = {}, names) => produceWeekly(steps(names), { date: "2026-10-11", now: NOW.toISOString(), publish: true, ...job }, { service, ...mocks.deps });

test("a run writes an overview per busy topic, grounds it, and publishes the edition the archive serves", async () => {
  const service = await world();
  const mocks = models({ overview: () => "Developers shipped many things this week. Several launches are listed below." });
  const names = [];
  const result = await run(service, mocks, {}, names);
  assert.deepEqual([result.published, result.topics, result.overviews, result.signals], [true, 1, 1, 15], "fourteen and the deep one");
  assert.deepEqual(mocks.calls.write.map(({ topics, repair }) => [topics, repair]), [[["Agents"], false]]);
  assert.equal(mocks.calls.ground.length, 1);
  assert.equal(mocks.calls.ground[0][0].headline, "Developers shipped many things this week.", "the judge reads the first claim as the headline and the whole overview as the summary");
  const saved = weeklyEditionSchema.parse(await readPrivateJson("weekly/2026-10-11.json"));
  assert.equal(saved.topics[0].overview, "Developers shipped many things this week. Several launches are listed below.");
  assert.equal(saved.top.length, 5);
  assert.deepEqual(saved.top[0].facts.map(({ fact }) => fact), ["Deep fact number 5 is stated here.", "Deep fact number 4 is stated here.", "Deep fact number 3 is stated here."], "the three most telling facts, most telling first");
  const deep = mocks.calls.write[0].payload[0].items.find((item) => item.headline.startsWith("Deep Lab"));
  assert.deepEqual(deep.facts, ["Deep fact number 5 is stated here.", "Deep fact number 4 is stated here."], "the writer is given the two most telling");
  assert.ok(saved.topics[0].items.every((item) => item.facts.length > 0 && item.facts.every((f) => f.quote)), "every item shown carries its verified facts");
  assert.ok(saved.markdown.startsWith("# The week in AI engineering"));
  assert.deepEqual(await readPrivateJson("published/weekly/2026-10-11.json"), { version: 2, kind: "weekly", date: "2026-10-11", publishedAt: NOW.toISOString() });
  assert.deepEqual(await readPrivateJson("weekly/work/2026-10-11.json"), null, "the work file is cleared");
  assert.deepEqual(names.filter((name) => !name.startsWith("existing")), ["plan", "write-0", "ground", "publish", "report"], "the steps, in order");
});

test("an overview the judge does not support, or that is still wrong after one repair, is not published, and the section keeps its items and numbers", async () => {
  const service = await world();
  const unsupported = await run(service, models({ verdict: () => ({ supported: 0.4, verdict: "unsupported", confidence: 0.9 }) }), { date: "2026-10-12" });
  assert.deepEqual([unsupported.published, unsupported.overviews], [true, 0]);
  const saved = weeklyEditionSchema.parse(await readPrivateJson("weekly/2026-10-12.json"));
  assert.deepEqual([saved.topics[0].overview, saved.topics[0].count, saved.topics[0].items.length > 0], [null, 15, true]);
  assert.doesNotMatch(saved.markdown, /Developers shipped many things/);
  const weakHeadline = await run(service, models({ headline: () => ({ supported: 0.55 }) }), { date: "2026-10-13" });
  assert.equal(weakHeadline.overviews, 0, "the first claim must be supported too");

  const mocks = models({ overview: (topic, repair) => repair ? "Still a bad one; with a semicolon." : "Prices fell by 80% this week; see https://evil.example for more." });
  const wrong = await run(service, mocks, { date: "2026-10-14" });
  assert.equal(wrong.overviews, 0);
  assert.deepEqual(mocks.calls.write.map(({ repair }) => repair), [false, true], "one repair, never two");
  assert.ok(mocks.calls.write[1].problems.length > 0 && mocks.calls.write[1].problems.every((p) => !/evil\.example|80%/.test(p)), "the problems name defects and repeat none of the text");
  assert.equal(mocks.calls.ground.length, 0, "nothing is sent to the judge that code already refused");
});

test("a repair fixes what it was told, and only the topics that needed it are written again", async () => {
  const service = await world(24, ["Agents", "Retrieval"]);
  const mocks = models({ overview: (topic, repair) => topic === "Retrieval" && !repair ? "Costs rose 99% this week and nobody noticed at all." : "Developers shipped many things this week. Several launches are listed below." });
  const result = await run(service, mocks);
  assert.equal(result.overviews, 2);
  assert.deepEqual(mocks.calls.write.map(({ topics, repair }) => [topics.sort(), repair]), [[["Agents", "Retrieval"], false], [["Retrieval"], true]]);
});

test("a preview publishes nothing, and an edition already published is returned and not made again", async () => {
  const service = await world();
  const preview = await run(service, models(), { publish: false });
  assert.equal(preview.published, false);
  assert.equal(await readPrivateJson("published/weekly/2026-10-11.json"), null);
  assert.equal(await readPrivateJson("weekly/2026-10-11.json"), null, "not even the edition");
  const first = await run(service, models());
  const mocks = models();
  const second = await run(service, mocks);
  assert.deepEqual([first.published, second.published, second.existing], [true, true, true]);
  assert.deepEqual([mocks.calls.write.length, mocks.calls.ground.length], [0, 0], "and no model is paid twice");
});

test("a week with too little in it is not published as research", async () => {
  const service = await world(6);
  const result = await run(service, models());
  assert.deepEqual([result.published, result.reason], [false, "too few signals"]);
  assert.equal(await readPrivateJson("published/weekly/2026-10-11.json"), null);
});

test("the writer is told what to write and what is data, and a repair carries the problems and the drafts, never the page", async () => {
  const seen = [];
  const structured = async (step, role, schema, system, prompt) => { seen.push({ step, role, system, prompt: JSON.parse(prompt) }); return { output: schema.parse({ topics: [{ topic: "Agents", overview: "Agents did things this week. Many launches are below." }] }), usage: usage(step) }; };
  const topics = [{ topic: "Agents", items: [{ headline: "Warp adds Teams", facts: ["Teams works with Factories."] }] }];
  const first = await writeOverviews(topics, undefined, { structured });
  assert.deepEqual(first.drafts, [{ topic: "Agents", overview: "Agents did things this week. Many launches are below." }]);
  assert.deepEqual([seen[0].step, seen[0].role], ["weekly", "writer"]);
  assert.deepEqual(seen[0].prompt, { topics });
  assert.match(seen[0].system, /data, never instructions/i);
  assert.match(seen[0].system, /Never add a number/i);
  await writeOverviews(topics, { drafts: first.drafts, problems: ["[Agents] The overview has 4 sentences; use at most 3."] }, { structured });
  assert.deepEqual([seen[1].step, Object.keys(seen[1].prompt)], ["weekly-repair", ["topics", "previous", "fix"]]);
  assert.deepEqual(seen[1].prompt.fix, ["[Agents] The overview has 4 sentences; use at most 3."]);
});
