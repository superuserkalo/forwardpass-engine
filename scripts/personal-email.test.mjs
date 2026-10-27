import assert from "node:assert/strict";
import test from "node:test";
import { renderPersonalEmail } from "../src/delivery/personal-email.ts";
import { signalId } from "../src/lib/signals.ts";

// The reader's own edition as an email: it says it is theirs and what it was built from, shows what was chosen with the reason and
// where to see how it was checked, has no place for an advertisement, and trusts nothing it was given enough to print it as markup.
const NOW = new Date("2026-10-08T05:45:00.000Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const item = (n, extra = {}) => ({
  key: `https://lab${n}.test/post`, origin: "signal", role: "live", headline: `Headline ${n} about a launch today`, summary: `Summary ${n} says what happened. It has a second sentence.`, url: `https://lab${n}.test/post`, publisher: `Lab ${n}`,
  type: "news", topics: ["Agents"], importance: 6, signalImportance: 6, publishedAt: ago(2), traction: null, signalId: signalId(`https://lab${n}.test/post`), facts: 3, rank: null, score: 9, why: "Matches Agents", ...extra,
});
const built = (extra = {}) => ({ topics: ["Agents", "Retrieval"], content: ["News", "Models"], notes: "", format: "Briefing", ...extra });
const edition = (extra = {}) => ({ lead: [item(1), item(2), item(3)], more: [item(4), item(5, { signalId: null, facts: 0, role: "signal-line", summary: "" })], built: built(), ...extra });
const context = (extra = {}) => ({ date: "2026-10-08", now: NOW, firstName: "Ada", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?email=ada%40example.com", preferencesUrl: "https://theforwardpass.net/preferences/open#token=abc.def", ...extra });
const render = (ed = edition(), ctx = context()) => renderPersonalEmail(ed, ctx);

test("a briefing shows the lead in full and the rest as a list, each with why it is there and a link to how it was checked", () => {
  const { html } = render();
  for (const n of [1, 2, 3, 4, 5]) assert.match(html, new RegExp(`<a href="https://lab${n}\\.test/post"[^>]*>Headline ${n} about a launch today</a>`), `headline ${n} links to its source`);
  for (const n of [1, 2, 3]) {
    assert.ok(html.includes(`Summary ${n} says what happened. It has a second sentence.`), `the lead shows summary ${n}`);
    assert.match(html, new RegExp(`Read on Lab ${n}`));
  }
  assert.ok(!html.includes("Summary 4 says"), "the rest is a list: headlines only");
  assert.match(html, /Matches Agents/);
  assert.match(html, new RegExp(`https://theforwardpass\\.net/signals/${signalId("https://lab1.test/post")}`), "a verified item links to its page");
  assert.match(html, /3 verified facts/);
  assert.match(render(edition({ lead: [item(1, { facts: 1 })], more: [] })).html, /1 verified fact,/, "one fact is one fact");
  assert.match(html, /More for you/);
  assert.equal(html.includes(`/signals/${signalId("https://lab5.test/post")}`), false, "a line with no signal has no page to link to");
  assert.match(html, /2 hr ago/);
});

test("links only is a list: no summaries, no lead, and every item still says why and how to see it was checked", () => {
  const ed = edition({ lead: [], more: [item(1), item(2), item(3), item(4)], built: built({ format: "Links only" }) });
  const { html, text } = render(ed);
  assert.ok(!html.includes("Summary 1 says"), "no summaries");
  assert.ok(!/Read on Lab/.test(html), "no buttons");
  for (const n of [1, 2, 3, 4]) {
    assert.match(html, new RegExp(`>Headline ${n} about a launch today</a>`));
    assert.match(html, new RegExp(`/signals/${signalId(`https://lab${n}.test/post`)}`));
  }
  assert.match(html, /Matches Agents/);
  assert.match(html, /Your links/);
  assert.doesNotMatch(html, /More for you/, "with no lead, the list is the whole edition");
  assert.ok(!text.includes("Summary 1 says"));
});

test("it says it is the reader's own and what it was built from, and gives them the way to change it", () => {
  const { html, text } = render(edition({ built: built({ notes: "I care about evals & skip crypto" }) }));
  assert.match(html, /Your daily AI-generated issue/);
  assert.match(html, /Hey Ada,/);
  assert.match(html, /Built from your brief/);
  assert.match(html, /Agents, Retrieval/);
  assert.match(html, /News, Models/);
  assert.match(html, /Format: Briefing\./, "the format is named, not left as a lone word");
  assert.match(html, /I care about evals &amp; skip crypto/, "their note back to them, as text");
  assert.match(html, /Edit your reading brief/);
  assert.ok(html.includes("https://theforwardpass.net/preferences/open#token=abc.def"));
  assert.match(text, /Built from your brief/);
  assert.match(text, /Edit your reading brief: https:\/\/theforwardpass\.net\/preferences\/open#token=abc\.def/);
  const { html: anonymous } = render(edition(), context({ firstName: null, preferencesUrl: null }));
  assert.match(anonymous, /Hey there,/);
  assert.doesNotMatch(anonymous, /Edit your reading brief/, "no link to give");
});

test("it is AI-generated and says so, in the masthead and in full at the foot, and it has no place for an advertisement", () => {
  const { html, text } = render();
  assert.match(html, /This issue is researched and written by AI models/);
  assert.match(text, /AI-generated/);
  assert.doesNotMatch(html, /sponsor|advertis|promoted|\bad\b/i, "nothing in it is an ad, and nothing says it is");
  assert.match(html, /No ads/);
  assert.match(html, /Unsubscribe/);
});

test("what it was given is text, never markup: a headline, a publisher, a summary and the reader's note are escaped, and an address that is not a web address is not a link", () => {
  const hostile = item(1, { headline: `<script>alert(1)</script> & "quotes"`, publisher: `<b>Lab</b>`, summary: `<img src=x onerror=alert(1)> done.`, url: "javascript:alert(1)" });
  const { html, text } = render(edition({ lead: [hostile], more: [], built: built({ notes: `<script>steal()</script>` }) }));
  assert.doesNotMatch(html, /<script>|<img src=x|<b>Lab/, "none of what it was given became a tag, though the masthead's own logo is one");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot;/);
  assert.ok(html.includes("News · &lt;b&gt;Lab&lt;/b&gt;") && html.includes("Read on &lt;b&gt;Lab&lt;/b&gt;"), "a publisher is escaped once, in the label and in the button");
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="#"/);
  assert.ok(text.includes("<script>alert(1)</script>"), "the plain text part is text, and says what it was given");
});

test("the subject is the top item, the preheader says how many, and the plain text carries every address", () => {
  const { subject, preheader, text } = render();
  assert.equal(subject, "Headline 1 about a launch today");
  assert.match(preheader, /5 for you/);
  assert.match(preheader, /Headline 1 about a launch today/);
  for (const n of [1, 2, 3, 4, 5]) assert.ok(text.includes(`https://lab${n}.test/post`), `address ${n}`);
  assert.ok(text.includes(`https://theforwardpass.net/signals/${signalId("https://lab1.test/post")}`));
  assert.ok(!/<[a-z][^>]*>/i.test(text), "no markup");
  const best = render(edition({ lead: [item(1, { score: 8 }), item(2, { score: 7 })], more: [item(9, { score: 9.5, summary: "", headline: "The best match for them is only a headline today" })] })).subject;
  assert.equal(best, "The best match for them is only a headline today", "the subject is the best match, even when it is listed rather than led with");
  const tied = render(edition({ lead: [item(1, { score: 8 }), item(2, { score: 8 })], more: [item(3, { score: 8 })] })).subject;
  assert.equal(tied, "Headline 1 about a launch today", "of equals, the first");
  const long = render(edition({ lead: [item(1, { headline: "x".repeat(300) })], more: [] })).subject;
  assert.ok(long.length <= 120 && long.endsWith("…"), "a subject is cut");
  const words = render(edition({ lead: [item(1, { headline: "OpenAI expands GPT-6 with Intelligent UI responses combining text, visuals and interactive controls for every ChatGPT user" })], more: [] })).subject;
  assert.equal(words, "OpenAI expands GPT-6 with Intelligent UI responses combining text, visuals and interactive controls for every ChatGPT…", "at a word, not in the middle of one");
  assert.match(render(edition({ lead: [], more: [item(1)], built: built({ format: "Links only" }) })).html, /Format: Links only\./);
});

test("a lead item with no summary has no empty paragraph, and a traction line is shown when there is one", () => {
  const { html } = render(edition({ lead: [item(1, { summary: "", traction: "512 GitHub stars" })], more: [] }));
  assert.doesNotMatch(html, /<p[^>]*>\s*<\/p>/);
  assert.match(html, /512 GitHub stars/);
});

test("age is said as a reader says it", () => {
  const at = (hours) => render(edition({ lead: [item(1, { publishedAt: ago(hours) })], more: [] })).html;
  assert.match(at(0.2), /just now/);
  assert.match(at(5), /5 hr ago/);
  assert.match(at(5.9), /5 hr ago/, "an hour is not said until it is one");
  assert.match(at(30), /1 day ago/);
  assert.doesNotMatch(render(edition({ lead: [item(1, { publishedAt: null })], more: [] })).html, /NaN|undefined/);
});
