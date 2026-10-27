import assert from "node:assert/strict";
import test from "node:test";
import { renderWeeklyEmail } from "../src/delivery/weekly-email.ts";
import { EDITION, item, topic } from "./weekly-fixture.mjs";

// The weekly research as an email: the week's top, then the reader's own topics in their order with the overview where the judge
// supported one, each item with its best fact and a link to how it was checked, and a plain line about the topics they do not follow.
const context = (extra = {}) => ({ firstName: "Ada", topics: ["Retrieval", "Agents"], unsubscribeUrl: "https://theforwardpass.net/unsubscribe?email=ada%40example.com", preferencesUrl: "https://theforwardpass.net/preferences/open#token=abc.def", ...extra });
const render = (edition = EDITION(), ctx = context()) => renderWeeklyEmail(edition, ctx);

test("it opens with the week's top and then the reader's topics, in their order, and leaves the others to one line", () => {
  const { html } = render();
  assert.match(html, /Your weekly AI-generated research/);
  assert.match(html, /Hey Ada,/);
  assert.match(html, /4 to 11 October/);
  assert.match(html, /40 verified signals across 4 topics/);
  assert.match(html, /Top of the week/);
  for (const n of [10, 11, 12]) assert.match(html, new RegExp(`>Pub ${n} ships thing ${n} for developers</a>`));
  assert.ok(html.indexOf("Retrieval moved this week") < html.indexOf("Agents moved this week"), "the reader's order, not the edition's");
  assert.ok(html.indexOf("Top of the week") < html.indexOf("Retrieval moved this week"));
  assert.doesNotMatch(html, /Security moved this week/, "a topic they do not follow has no section");
  assert.match(html, /Also this week: Security \(6\), Video \(4\)/);
  assert.match(html, /Built around your topics: Retrieval, Agents/);
});

test("each topic shows its overview when there is one, its items with their best fact and a link to the evidence, and how the week compared", () => {
  const { html } = render();
  assert.match(html, /Agents moved this week\. Several launches are listed below\./);
  assert.match(html, /Pub 1 shipped thing 1 on Tuesday\./, "the best fact of an item");
  assert.match(html, /\/signals\/g-[a-f0-9]{16}"[^>]*>[^<]*checked/i);
  assert.match(html, /20 signals this week, up from 18/);
  assert.match(html, /Most from Pub 1/);
  const { html: quiet } = render(EDITION(), context({ topics: ["Security", "Video"] }));
  assert.doesNotMatch(quiet, /Security moved this week/, "an overview the judge did not support is not in the email");
  assert.match(quiet, /Pub 3 ships thing 3 for developers/, "but the section keeps its items");
  assert.match(quiet, /6 signals this week, up from 4/);
  assert.match(quiet, /4 signals this week, none last week/);
});

test("a reader whose topics were all quiet, or who has none, still gets the week: the top and the three busiest topics", () => {
  const { html } = render(EDITION(), context({ topics: [] }));
  assert.match(html, /Top of the week/);
  for (const name of ["Agents", "Retrieval", "Security"]) assert.match(html, new RegExp(`>${name}<`), name);
  assert.doesNotMatch(html, /Built around your topics/, "nothing to say they chose");
  const { html: absent } = render(EDITION(), context({ topics: ["Robotics"] }));
  assert.match(absent, /Quiet this week: Robotics/);
  assert.match(absent, />Agents</, "the busiest stand in");
});

test("it says it is AI-generated, links the full edition, the brief and unsubscribe, and has no place for an advertisement", () => {
  const { html, text } = render();
  assert.match(html, /This issue is researched and written by AI models/);
  assert.match(html, /https:\/\/theforwardpass\.net\/archive\/weekly\/2026-10-11/);
  assert.match(html, /Edit your reading brief/);
  assert.match(html, /Unsubscribe/);
  assert.doesNotMatch(html, /sponsor|advertis|promoted|\bad\b/i);
  assert.match(text, /AI-generated/);
  assert.match(text, /archive\/weekly\/2026-10-11/);
  assert.ok(!/<[a-z][^>]*>/i.test(text.replace(/<script>/g, "")), "plain text");
});

test("the subject names the reader's topics and leads with the best item in the first of them, else the week's top item, and what it was given is text", () => {
  const { subject, preheader } = render();
  assert.equal(subject, "Your week in Retrieval and Agents: Pub 1 ships thing 1 for developers", "an item in their own topic, not the week's top if that is about something else");
  assert.match(preheader, /40 verified signals/);
  assert.match(preheader, /Pub 1 ships thing 1 for developers/);
  assert.equal(render(EDITION(), context({ topics: ["Security"] })).subject, "Your week in Security: Pub 3 ships thing 3 for developers");
  assert.equal(render(EDITION(), context({ topics: ["Video", "Security"] })).subject, "Your week in Video and Security: Pub 3 ships thing 3 for developers", "the first of their topics that has anything to lead with");
  assert.equal(render(EDITION(), context({ topics: [] })).subject, "The week in AI engineering: Pub 10 ships thing 10 for developers");
  assert.equal(render(EDITION(), context({ topics: ["Robotics"] })).subject, "The week in AI engineering: Pub 10 ships thing 10 for developers", "none of their topics had a week");
  const hostile = EDITION();
  hostile.top[0].headline = `<script>alert(1)</script> & "x"`;
  hostile.topics[0].overview = `<img src=x onerror=alert(1)> done`;
  hostile.topics[0].items[0].url = "javascript:alert(1)";
  hostile.topics[0].items[0].facts[0].fact = "<b>fact</b> & more";
  hostile.topics[0].items[0].publisher = "<i>Pub</i>";
  const { html } = render(hostile, context({ topics: ["Agents"] }));
  assert.doesNotMatch(html, /<script>|<img src=x|<b>fact|<i>Pub/);
  assert.ok(html.includes("&lt;b&gt;fact&lt;/b&gt; &amp; more") && html.includes("&lt;i&gt;Pub&lt;/i&gt;"), "a fact and a publisher are escaped once");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
  assert.doesNotMatch(html, /href="javascript:/);
  const long = EDITION();
  long.topics[1].items[0].headline = "x".repeat(300);
  const { subject: cut } = render(long);
  assert.ok(cut.length <= 120 && cut.endsWith("…"), "a subject is cut");
  const words = EDITION();
  words.top[0].headline = "OpenAI expands GPT-6 with Intelligent UI responses combining text, visuals and interactive controls for every ChatGPT user";
  assert.equal(render(words, context({ topics: [] })).subject, "The week in AI engineering: OpenAI expands GPT-6 with Intelligent UI responses combining text, visuals and interactive…", "at a word, not in the middle of one");
});

test("an item is shown once: what is in the top of the week, or in an earlier section, is not repeated in the ones after it", () => {
  const edition = EDITION();
  edition.topics[0].items = [item(10, { importance: 9 }), item(1), item(2)];
  const { html, text } = render(edition, context({ topics: ["Agents", "Retrieval"] }));
  const times = (needle) => html.split(needle).length - 1;
  assert.equal(times(">Pub 10 ships thing 10 for developers</a>"), 1, "in the top, and not again under Agents");
  assert.equal(times(">Pub 1 ships thing 1 for developers</a>"), 1, "under Agents, and not again under Retrieval");
  assert.equal(times(">Pub 2 ships thing 2 for developers</a>"), 1);
  assert.equal(text.split("https://pub1.test/post").length - 1, 1, "nor in the plain text");
  assert.equal(text.split("https://pub10.test/post").length - 1, 1);
  assert.match(html, /Retrieval moved this week/, "a section whose items were all shown keeps its overview");
  assert.match(html, /10 signals this week, up from 8/, "and how the week compared");
  assert.equal(times("Its top items are shown above."), 1, "and says where its items went; the section that kept some of its own does not say it");
  assert.match(text, /Its top items are shown above\./);
  assert.ok(html.indexOf(">01<", html.indexOf("Agents moved this week")) > 0, "the numbering of what is left starts again at one");
  const { html: other } = render(edition, context({ topics: ["Retrieval", "Agents"] }));
  assert.equal(other.split(">Pub 1 ships thing 1 for developers</a>").length - 1, 1, "in the order the reader chose");
});

test("a topic's closing line names its publishers only when one of them appeared more than once, since otherwise none of them is 'most'", () => {
  const edition = EDITION();
  edition.topics[0].publishers = [{ name: "Mastra", count: 1 }, { name: "Microsoft", count: 1 }, { name: "Warp", count: 1 }];
  const { html, text } = render(edition, context({ topics: ["Agents"] }));
  assert.doesNotMatch(html, /Most from/);
  assert.match(html, /20 signals this week, up from 18 last week\./, "and the count is still said");
  assert.ok(text.split("\n").includes("20 signals this week, up from 18 last week."), "as a whole line, with nothing after it");
  edition.topics[0].publishers = [{ name: "Mastra", count: 3 }, { name: "Microsoft", count: 2 }, { name: "Warp", count: 1 }];
  const named = render(edition, context({ topics: ["Agents"] }));
  assert.match(named.html, /Most from Mastra and Microsoft\./, "those that published more than once; the others are not named");
  assert.ok(named.text.split("\n").includes("20 signals this week, up from 18 last week. Most from Mastra and Microsoft."), "and the plain text says it too");
});

test("a section with one item says signal, not signals", () => {
  const edition = EDITION();
  edition.topics[3] = topic("Video", 1, { previousCount: 0, items: [] });
  edition.topics[2] = topic("Security", 1, { previousCount: 3, overview: null, items: [item(3)] });
  const { html } = render(edition, context({ topics: ["Video", "Security"] }));
  assert.match(html, /1 signal this week, none last week/);
  assert.match(html, /1 signal this week, down from 3 last week/);
  assert.doesNotMatch(html, /\b1 signals\b/);
  assert.doesNotMatch(html, /shown above/, "a section with no items at all has nothing that went elsewhere");
  assert.match(render(edition, context({ topics: ["Agents"] })).html, /20 signals this week/, "and plural otherwise");
  edition.topics[3] = topic("Video", 2, { previousCount: 0, items: [] });
  assert.match(render(edition, context({ topics: ["Video"] })).html, /2 signals this week, none last week/, "two is plural");
});

test("the way to the full edition is always in the footer, and the items are numbered", () => {
  const all = ["Agents", "Retrieval", "Security", "Video"];
  const { html } = render(EDITION(), context({ topics: all }));
  assert.doesNotMatch(html, /Also this week/, "every topic has its own section, so there is nothing to add");
  assert.match(html, /<a href="https:\/\/theforwardpass\.net\/archive\/weekly\/2026-10-11"[^>]*>Read the full edition<\/a>/);
  assert.match(html, />01</);
  assert.match(html, />02</);
});

test("with no name or brief link it is the same email without them", () => {
  const { html } = render(EDITION(), context({ firstName: null, preferencesUrl: null }));
  assert.match(html, /Hey there,/);
  assert.doesNotMatch(html, /Edit your reading brief/);
});
