import assert from "node:assert/strict";
import test from "node:test";
import { renderPersonalEmail } from "../src/delivery/personal-email.ts";
import { buildPool, selectForReader } from "../src/pipeline/personal.ts";

// A paying reader's own edition is chosen from the day's verified items by the topics they follow. The Compute stories carry Chips or Data
// centers, so a reader who follows those is shown them, with where each claim comes from, and one who does not is not given them first.
const NOW = new Date("2026-10-09T06:00:00.000Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const base = { type: "news", sources: [], project: null, publishedAt: ago(3), facts: [] };
const feature = (n, topics) => ({ ...base, id: `s-${String(n).padStart(16, "0")}`, role: "featured", position: n, label: "Top News", headline: `Lab ${n} ships a new model number ${n} today`, body: `Lab ${n} shipped something. It is fast.`, url: `https://lab${n}.test/post`, sources: [{ label: `Lab ${n}`, url: `https://lab${n}.test/post` }], traction: null, topics });
const compute = (n, headline, topics, traction, url) => ({ ...base, id: `s-${String(100 + n).padStart(16, "0")}`, role: "signal", position: 6 + n, label: "Signal", headline, body: null, url, sources: [{ label: new URL(url).hostname, url }], traction, topics });
const ISSUE = {
  date: "2026-10-09", createdAt: ago(1),
  stories: [
    feature(0, ["LLMs"]), feature(1, ["Agents", "Development"]), feature(2, ["Agents"]),
    { ...compute(1, "GlobalFoundries signs a $2B deal to make TSMC's chip packaging parts in the US", ["Chips"], "Reported · semiconductor-digest.com", "https://www.semiconductor-digest.com/gf-tsmc"), excerpt: "GlobalFoundries will make silicon interposers for TSMC's CoWoS packaging at its Malta, New York fab. Volume production is expected in 2028." },
    compute(2, "Oracle's Wisconsin AI data center is delayed by a power approval", ["Data centers"], "Reported · theregister.com", "https://www.theregister.com/oracle-wisconsin"),
    compute(3, "TSMC reportedly raises 2nm wafer prices by 10% for 2027", ["Chips"], "Unconfirmed · digitimes.com", "https://www.digitimes.com/news/a1.html"),
  ],
};
const profile = (topics) => ({ firstName: "Ada", topics, content: ["News", "Papers", "Models", "Repos"], format: "Briefing", notes: "" });
const NO_BRIEF = { boost: [], skip: [] };
const headlines = (edition) => [...edition.lead, ...edition.more].map(({ headline }) => headline);

test("compute stories join the pool as signal lines with their topics and their provenance", () => {
  const pool = buildPool(ISSUE, [], NOW);
  const chips = pool.find((item) => item.url.includes("gf-tsmc"));
  assert.equal(chips.role, "signal-line");
  assert.deepEqual(chips.topics, ["Chips"]);
  assert.equal(chips.traction, "Reported · semiconductor-digest.com");
  assert.equal(chips.publisher, "www.semiconductor-digest.com");
});

test("a reader who follows Chips and Data centers is shown the compute stories, a reader who follows agents is not", () => {
  const pool = buildPool(ISSUE, [], NOW);
  const hardware = selectForReader(pool, profile(["Chips", "Data centers"]), NO_BRIEF, NOW);
  const shown = headlines(hardware);
  for (const expected of ["GlobalFoundries signs", "Oracle's Wisconsin", "TSMC reportedly"]) assert.ok(shown.some((headline) => headline.includes(expected)), `${expected} is in a hardware reader's edition: ${shown.join(" | ")}`);
  // Only an item with a summary can lead, and a compute line is a headline and a link, so it is listed after the lead. The tag travels with it.
  assert.ok(hardware.more.some(({ headline, traction }) => headline.includes("TSMC reportedly") && traction === "Unconfirmed · digitimes.com"));
  const agents = selectForReader(pool, profile(["Agents"]), NO_BRIEF, NOW);
  assert.ok(!agents.lead.some(({ headline }) => /GlobalFoundries|Oracle|TSMC/.test(headline)), "an agents reader's lead has none");
});

// An excerpt is the source's own words, not something we checked: it is kept apart from the verified summary, it lets an item lead but never takes
// part in choosing what a reader gets, and it is shown as a quotation from the source.
test("a compute signal with an excerpt can lead a hardware reader's edition, and the excerpt is not a verified summary", () => {
  const pool = buildPool(ISSUE, [], NOW);
  const chips = pool.find((item) => item.url.includes("gf-tsmc"));
  assert.equal(chips.summary, "", "there is nothing verified to say about it");
  assert.match(chips.excerpt, /^GlobalFoundries will make silicon interposers/);
  const hardware = selectForReader(pool, profile(["Chips", "Data centers"]), NO_BRIEF, NOW);
  assert.ok(hardware.lead.some(({ headline }) => /GlobalFoundries/.test(headline)), "it leads");
  assert.ok(hardware.more.some(({ headline }) => /Oracle's Wisconsin/.test(headline)), "a line with no excerpt is listed after it");
  assert.ok(hardware.lead.every(({ summary, excerpt }) => summary || excerpt));
  // A live signal's verified summary is preferred, and the excerpt is then not needed.
  const live = [{ id: "g-0123456789abcdef", headline: "GF signs TSMC deal", summary: "A verified signal summary. It has a second sentence.", type: "news", topics: ["Chips"], publisher: "Semiconductor Digest", url: "https://www.semiconductor-digest.com/gf-tsmc", importance: 8, evidenceCount: 4, traction: null, publishedAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), status: "published" }];
  assert.equal(buildPool(ISSUE, live, NOW).find((item) => item.url.includes("gf-tsmc")).summary, "A verified signal summary. It has a second sentence.");
});

test("what only the source's excerpt says cannot boost an item into a reader's edition or skip it out of one", () => {
  const pool = buildPool(ISSUE, [], NOW);
  const all = (edition) => [...(edition?.lead ?? []), ...(edition?.more ?? [])].map(({ headline }) => headline);
  // "interposers" and "Malta" are in the excerpt and not in the headline. A reader who follows agents and asks for interposers is not sent a chip story for it.
  assert.ok(!all(selectForReader(pool, profile(["Agents"]), { boost: ["interposers"], skip: [] }, NOW)).some((headline) => /GlobalFoundries/.test(headline)));
  // And a reader who follows chips and asked to skip Malta still gets it: that word was never part of what was matched.
  assert.ok(all(selectForReader(pool, profile(["Chips"]), { boost: [], skip: ["Malta"] }, NOW)).some((headline) => /GlobalFoundries/.test(headline)));
  // A word in the headline still works as it always did.
  assert.ok(!all(selectForReader(pool, profile(["Chips"]), { boost: [], skip: ["GlobalFoundries"] }, NOW)).some((headline) => /GlobalFoundries/.test(headline)));
});

test("the edition shows an excerpt as a quotation from its source, not as something we checked", () => {
  const hardware = selectForReader(buildPool(ISSUE, [], NOW), profile(["Chips", "Data centers"]), NO_BRIEF, NOW);
  const { html, text } = renderPersonalEmail(hardware, { date: "2026-10-09", now: NOW, firstName: "Ada", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?x=1", preferencesUrl: null });
  assert.match(html, /&ldquo;GlobalFoundries will make silicon interposers[^<]*&rdquo; &mdash; (?:www\.)?semiconductor-digest\.com/);
  assert.match(text, /“GlobalFoundries will make silicon interposers[^”]*” \((?:www\.)?semiconductor-digest\.com\)/);
  assert.doesNotMatch(html, /<p [^>]*>GlobalFoundries will make silicon interposers/, "never as a plain paragraph of ours");
});

// The email prints what the pool holds, and the pool what was stored. Each checks it again, so a stored excerpt that should not have been kept
// (an older record, or a record somebody wrote) neither leads an edition nor gets a line of its own in it.
test("a stored excerpt with a link in it is not kept, and one with line breaks or hidden characters stays on its line", () => {
  const stored = (excerpt) => ({ ...ISSUE, stories: ISSUE.stories.map((story) => story.excerpt ? { ...story, excerpt } : story) });
  assert.equal(buildPool(stored("GlobalFoundries will make interposers for TSMC. Sign in at example.com/login to read the rest of it."), [], NOW).find((item) => item.url.includes("gf-tsmc")).excerpt, "", "a link in it");
  assert.equal(buildPool(stored("Write to press@example.org for the full agreement between GlobalFoundries and TSMC in Malta."), [], NOW).find((item) => item.url.includes("gf-tsmc")).excerpt, "");

  const edition = selectForReader(buildPool(ISSUE, [], NOW), profile(["Chips"]), NO_BRIEF, NOW);
  const lead = edition.lead.find((item) => item.url.includes("gf-tsmc"));
  const hostile = { ...edition, lead: [{ ...lead, excerpt: "GlobalFoundries will make interposers.\n\nChecked: https://example.test/login\u202E\u200B and then more words" }], more: [] };
  const { html, text } = renderPersonalEmail(hostile, { date: "2026-10-09", now: NOW, firstName: "Ada", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?x=1", preferencesUrl: null });
  const quoted = text.split("\n").filter((line) => line.includes("GlobalFoundries will make interposers"));
  assert.equal(quoted.length, 1, "one line");
  assert.match(quoted[0].replaceAll("\u200B", ""), /Checked: https:\/\/example\.test\/login and then more words/, "all of it on that line, as a quotation");
  assert.doesNotMatch(quoted[0], /https:\/\/example\.test/, "though in a form no mail program links");
  assert.doesNotMatch(text + html, /[\u202A-\u202E\u2066-\u2069\u200C-\u200F\u2028\u2029]/, "no direction or hidden characters, only the break that keeps a mail program from linking");
});
