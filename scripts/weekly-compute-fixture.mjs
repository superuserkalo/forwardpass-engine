// Daily issues as the pipeline saves them, with compute stories marked the way computeMarks marks them, for the weekly Compute report's tests.
export const hex = (n) => n.toString(16).padStart(16, "0");
export const fact = (text, quote, impact = 2) => ({ fact: text, quote, impact });

/** A compute story: `tag` is what code printed under its headline, and `url` is a secure address on the site the tag names. */
export function story(n, over = {}) {
  const site = over.site ?? "digitimes.com";
  const url = over.url ?? `https://www.${site}/news/a${n}.html`;
  return {
    id: `s-${hex(n)}`, role: "signal", position: over.position ?? n % 6, label: over.role === "featured" ? "Top News" : "Signal", type: "news",
    headline: over.headline ?? `Maker${n} raises wafer output guidance${n} for node${n} lines`, body: over.role === "featured" ? "A short body. It has two sentences." : null, url,
    sources: [{ label: `www.${site}`, url }], traction: over.traction ?? `${over.provenance ?? "Reported"} · ${site}`, topics: over.topics ?? ["Chips"], project: null,
    publishedAt: "2026-10-08T01:00:00.000Z", facts: over.facts ?? [],
    ...(over.role ? { role: over.role } : {}),
  };
}

/** An ordinary story, which the report ignores. */
export const plain = (n, over = {}) => ({ ...story(n, { site: "lab.test", traction: null, topics: ["Agents"], ...over }), traction: over.traction ?? null });

export function issue(date, stories, pool = [], extraChecks = {}) {
  return {
    version: 2, date, createdAt: `${date}T05:40:00.000Z`, subject: `Subject of ${date}`, preview: "preview", intro: ["one", "two", "three"],
    stories: stories.length ? stories : [plain(9000)], markdown: `# ${date}`,
    pipeline: { candidates: 1, clusters: 1, shortlisted: 1, kept: 1, models: {}, usage: [], checks: { compute: { lane: 10, rows: 5, placed: [], pool }, ...extraChecks } },
  };
}

import { computeWeekMarkdown, computeWeekSchema, planComputeWeek } from "../src/pipeline/weekly-compute.ts";

/** A finished edition for the week ending 11 October 2026, built the way a run builds one. */
export function EDITION(over = {}) {
  const issues = Array.from({ length: 7 }, (_, day) => {
    const date = `2026-10-${String(5 + day).padStart(2, "0")}`;
    return issue(date, [
      story(day * 10 + 1, { role: "featured", site: day === 3 ? "ctee.com.tw" : `maker${day}.test`, provenance: day === 0 ? "Official" : "Reported", ...(day === 3 ? { traction: "Reported · ctee.com.tw · translated from Chinese" } : {}), topics: day % 2 ? ["Data centers"] : ["Chips"], position: 0, facts: [fact(`Maker${day} raised output ${10 + day}% this quarter.`, `output ${10 + day}%`, 3), fact(`Maker${day} said lead times stay at ${20 + day} weeks.`, `${20 + day} weeks`, 2)] }),
      story(day * 10 + 2, { site: `trade${day}.test`, topics: ["Chips"], position: 1 }),
    ], day === 0 ? [{ url: "https://www.datacenterdynamics.com/en/news/bitdeer/", title: "Bitdeer AI signs 67MW AI cloud agreement in Malaysia", importance: 7 }] : []);
  });
  const plan = planComputeWeek(issues, "2026-10-11");
  const body = {
    version: 1, date: "2026-10-11", weekStart: plan.weekStart, weekEnd: plan.weekEnd, generatedAt: "2026-10-11T07:45:00.000Z",
    totals: { stories: plan.total, featured: plan.featured, official: plan.official, reported: plan.reported, unconfirmed: plan.unconfirmed, translated: plan.translated, days: plan.days, previousStories: plan.previousTotal },
    top: plan.top, numbers: plan.numbers, radar: plan.radar, evaluator: "jev",
    areas: plan.areas.map((area, i) => ({ area: area.area, count: area.count, previousCount: area.previousCount, overview: i === 0 ? "Makers raised output this quarter and kept lead times long. Several results are listed below." : null, grounding: null, items: area.items })),
    ...over,
  };
  return computeWeekSchema.parse({ ...body, markdown: computeWeekMarkdown({ ...body, markdown: "" }) });
}
