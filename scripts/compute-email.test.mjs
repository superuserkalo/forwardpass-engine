import assert from "node:assert/strict";
import test from "node:test";
import { issueMarkdown } from "../src/pipeline/assemble.ts";
import { renderIssueEmail } from "../src/delivery/email.ts";
import { ISSUE, OPTIONS } from "./email-fixture.mjs";

// Compute news is part of the issue: a compute story is a featured story or a signal like any other, in the same list, in the same place. What
// marks it is a line saying where its claim comes from, shown where an attention number would be.
const signal = (n, headline, traction, url) => ({
  id: `s-00000000000001${n}0`, role: "signal", position: 3 + n, label: "Signal", type: "news", headline, body: null, url, sources: [{ label: new URL(url).hostname, url }],
  traction, topics: ["Chips"], project: null, publishedAt: "2026-10-08T01:00:00.000Z", facts: [],
});
const featuredCompute = {
  id: "s-0000000000000200", role: "featured", position: 2, label: "Top News", type: "news", headline: "TSMC reports third-quarter revenue of NT$1.1 trillion",
  body: "TSMC said third-quarter revenue rose on AI demand. It raised its capital spending guidance.", url: "https://pr.tsmc.com/english/news/3200", sources: [{ label: "pr.tsmc.com", url: "https://pr.tsmc.com/english/news/3200" }],
  traction: "Official · tsmc.com", topics: ["Chips"], project: null, publishedAt: "2026-10-08T01:00:00.000Z", facts: [],
};
const WITH = {
  ...ISSUE,
  stories: [
    ...ISSUE.stories.slice(0, 2), featuredCompute, ...ISSUE.stories.slice(2),
    signal(1, "Samsung's profit rises ninefold to $80bn on AI chip demand", "Reported · ft.com · 312 HN points", "https://www.ft.com/content/abc"),
    signal(2, "TSMC reportedly raises 2nm wafer prices by 10% for 2027", "Unconfirmed · digitimes.com", "https://www.digitimes.com/news/a1.html"),
  ],
};

test("the archive Markdown has no section for compute: its stories are in the lists they were picked for, with where each claim comes from", () => {
  const md = issueMarkdown(WITH);
  assert.doesNotMatch(md, /## Compute/);
  assert.match(md, /\*\*Top News\*\* · Official · tsmc\.com/, "a featured compute story carries it under its label");
  const signals = md.slice(md.indexOf("## Signals"));
  assert.match(signals, /\[Samsung's profit rises ninefold to \$80bn on AI chip demand\]\(https:\/\/www\.ft\.com\/content\/abc\) · Reported · ft\.com · 312 HN points/);
  assert.match(signals, /\[TSMC reportedly raises 2nm wafer prices by 10% for 2027\]\(https:\/\/www\.digitimes\.com\/news\/a1\.html\) · Unconfirmed · digitimes\.com/);
  assert.equal(md.match(/^## /gm).length, ISSUE.stories.filter(({ role }) => role === "featured").length + 1 + 1, "the featured stories, the compute one among them, and the Signals");
});

test("the email has no section for compute either: the line shows under the headline of a featured story and a signal", () => {
  const { html, text } = renderIssueEmail(WITH, OPTIONS);
  assert.doesNotMatch(html, />Compute<\/h2>/);
  assert.doesNotMatch(text, /COMPUTE/);
  assert.ok(html.includes("Official · tsmc.com"), "under the featured headline");
  assert.ok(html.includes("Reported · ft.com · 312 HN points · ft.com") || html.includes("Reported · ft.com · 312 HN points"), "under the signal, with its number and its host");
  assert.ok(html.includes("Unconfirmed · digitimes.com"));
  assert.match(text, /SIGNALS\n\n1\. .*\n.*\n.*\n.*\n.*Samsung's profit rises ninefold to \$80bn on AI chip demand \(Reported · ft\.com · 312 HN points\)/s);
  assert.match(text, /TOP NEWS · Official · tsmc\.com\n\nTSMC reports third-quarter revenue/);
});

test("an issue with no compute story reads exactly as before", () => {
  assert.doesNotMatch(issueMarkdown(ISSUE), /Official|Reported|Unconfirmed/);
  const { html, text } = renderIssueEmail(ISSUE, OPTIONS);
  assert.doesNotMatch(html + text, /Official ·|Reported ·|Unconfirmed ·|Compute|COMPUTE/);
});
