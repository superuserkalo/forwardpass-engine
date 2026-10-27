import assert from "node:assert/strict";
import { test } from "node:test";
import { issueV2Schema, loadIssue } from "../src/lib/issue.ts";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";
import { nodeSteps } from "../src/node/steps.ts";
import { issueMarkdown, storyRecords } from "../src/pipeline/assemble.ts";
import { clusterCandidates, sectionLabel, shortlistClusters, storyType, traction } from "../src/pipeline/candidates.ts";
import { completePick } from "../src/pipeline/editor.ts";
import { bannedSnippets, cleanPunctuation, lengthIssues, metaIssues, scrubUngrounded, signalIssues, ungroundedNumbers } from "../src/pipeline/writing.ts";
import { AI_DISCLOSURE, AI_LABEL, renderIssueEmail } from "../src/delivery/email.ts";
import { deliverIssue, delivery, NEWSLETTER_TOPIC } from "../src/delivery/deliver.ts";

const candidate = (title, url, extra = {}) => ({ title, summary: "", url, publishedAt: "2026-09-28T01:00:00Z", source: "Lab", category: "primary announcement", ...extra });
const hn = (score) => [{ platform: "hacker-news", id: String(score), url: "https://x.test", measuredAt: "2026-09-28T02:00:00Z", previousMeasuredAt: null, elapsedHours: null, score, scoreDelta: null, scorePerHour: null, secondaryCount: 3, secondaryDelta: null }];

test("clustering joins one repository, near-identical titles and reposts of a release, and ranks by signal", () => {
  const clusters = clusterCandidates([
    candidate("vllm-project/vllm v0.30 adds faster graph capture", "https://github.com/vllm-project/vllm/releases/tag/v0.30.0"),
    candidate("vLLM release notes", "https://github.com/vllm-project/vllm", { source: "Hacker News", attention: hn(300) }),
    candidate("Researchers train agent groups to self organize across tasks", "https://a.test/agents"),
    candidate("Researchers train agent groups to self organize across tasks today", "https://b.test/agents"),
    candidate("Introducing GPT-6 Sol and Luna", "https://openai.com/index/gpt-6"),
    candidate("GPT-6 Sol now available in Azure", "https://azure.test/gpt-6", { source: "Azure" }),
    candidate("A weekly gardening column", "https://garden.test/column", { source: "Hacker News", publishedAt: null, attention: hn(4) }),
  ]);
  const titles = clusters.map((cluster) => cluster.items.map((item) => item.url).sort());
  assert.ok(titles.some((urls) => urls.length === 2 && urls.every((url) => url.includes("vllm-project/vllm"))));
  assert.ok(titles.some((urls) => urls.join() === "https://a.test/agents,https://b.test/agents"));
  assert.ok(titles.some((urls) => urls.join() === "https://azure.test/gpt-6,https://openai.com/index/gpt-6"));
  assert.equal(clusters.at(-1).lead.url, "https://garden.test/column");
  assert.equal(shortlistClusters(clusters, 2, 0).length, 2);
});

test("clustering 3,000 candidates takes well under a second", () => {
  const many = Array.from({ length: 3000 }, (_, i) => candidate(`Distinct development number ${i} about topic ${i % 97} and area ${i % 31}`, `https://s${i}.test/p`));
  const started = Date.now();
  clusterCandidates(many);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
});

test("story types, labels and traction come from the artifact and its measured attention", () => {
  assert.equal(storyType("https://arxiv.org/abs/2609.1"), "papers");
  assert.equal(storyType("https://huggingface.co/Qwen/Qwen3.8-27B"), "models");
  assert.equal(storyType("https://huggingface.co/blog/x"), "news");
  assert.equal(storyType("https://github.com/org/repo"), "repos");
  assert.equal(sectionLabel("https://github.com/org/repo"), "Top Repo");
  const [cluster] = clusterCandidates([candidate("A launch", "https://lab.test/a", { attention: hn(1762) })]);
  assert.equal(traction(cluster), "1,762 HN points");
  const [quiet] = clusterCandidates([candidate("A launch", "https://lab.test/a", { attention: hn(12) })]);
  assert.equal(traction(quiet), null);
});

test("the editor's empty slots are filled and signals get a paper, a model and a repo when worthwhile ones exist", () => {
  const urls = ["https://lab.test/1", "https://lab.test/2", "https://lab.test/3", "https://news.test/4", "https://news.test/5", "https://news.test/6", "https://news.test/7", "https://arxiv.org/abs/1", "https://huggingface.co/org/model", "https://github.com/org/tool"];
  const byId = new Map(urls.map((url, i) => [`c${i}`, { lead: { url, title: ["Lab ships compiler", "Court rules on chips", "Robots learn folding", "Startup raises funding", "Benchmark tracks agents", "Browser adds sandboxes", "Kernel speeds inference", "Paper studies scaling", "Open weights for speech", "Tool diffs notebooks"][i] }, items: [], score: 10 - i }]));
  const ranked = urls.map((_, i) => ({ id: `c${i}`, importance: i === 9 ? 4 : 8 - i * 0.2, keep: true, section: "tool", angle: "", topics: [], prerank: 0 }));
  const pick = completePick({ featured: urls.slice(0, 2), signals: urls.slice(3, 7), rationale: "", filled: [] }, ranked, byId);
  assert.equal(pick.featured.length, 3);
  assert.equal(pick.featured[2], "https://lab.test/3");
  assert.equal(pick.signals.length, 6);
  assert.ok(pick.signals.includes("https://arxiv.org/abs/1"));
  assert.ok(pick.signals.includes("https://huggingface.co/org/model"));
  // The repo's importance (4) is below the slot threshold, so it does not displace an editor pick.
  assert.ok(!pick.signals.includes("https://github.com/org/tool"));
  assert.equal(new Set([...pick.featured, ...pick.signals]).size, 9);
});

const material = { date: "2026-09-28", signalHeadlines: ["vLLM cuts capture from 12s to 2s"],
  featured: [{ label: "Top News", title: "Lab ships model", headlineFacts: ["It costs 40% less"], facts: ["It costs 40% less", "Output is 30% faster"], tryIt: null, alsoAvailableOn: [] }] };

test("numbers the facts do not support are found and scrubbed sentence by sentence", () => {
  const parts = { preview: "Lab ships model at 40% less", intro: ["Hook with 40% less. Another line.", "Meanwhile, 99 things.", "If you read one thing today: the launch, it costs 40% less."],
    featured: [{ headline: "Lab ships model 55% cheaper", body: "It costs 40% less. It has 128 experts.\n\n- Output is 30% faster\n- Trained on 7 trillion tokens" }] };
  assert.deepEqual(ungroundedNumbers(parts, material).sort(), ["128", "55", "99"]);
  const { parts: clean, removed } = scrubUngrounded(parts, material);
  assert.equal(clean.featured[0].headline, "Lab ships model");
  assert.equal(clean.featured[0].body, "It costs 40% less.\n\n- Output is 30% faster\n- Trained on 7 trillion tokens");
  assert.equal(clean.intro[1], "Meanwhile, the signals below are worth a look.");
  assert.equal(removed.length, 3);
  assert.deepEqual(ungroundedNumbers(clean, material), []);
});

test("writing guards: punctuation, source commentary, body length and signal rules", () => {
  assert.equal(cleanPunctuation("Fast — and cheap; really. Keep `a;b` code"), "Fast, and cheap. Really. Keep `a;b` code");
  assert.deepEqual(bannedSnippets("Use `x; y` here"), []);
  assert.equal(metaIssues({ preview: "", intro: ["", "", ""], featured: [{ headline: "h", body: "Try it: call the API. The source does not list install steps." }] }).length, 1);
  assert.equal(lengthIssues({ featured: [{ headline: "h", body: "Too short." }] }, [{ title: "Lab ships model" }]).length, 1);
  const item = { id: "s1", title: "facebook/sam3", project: "facebook/sam3", source: "HF", url: "https://huggingface.co/facebook/sam3", summary: "Segments 270K concepts", text: null };
  assert.deepEqual(signalIssues([item], [{ id: "s1", headline: "SAM 3 segments 270K concepts across images and video" }]), []);
  const issues = signalIssues([item], [{ id: "s1", headline: "Model gets 2 million downloads — and 900 likes" }]);
  assert.ok(issues.some((issue) => /popularity/.test(issue)) && issues.some((issue) => /em dash/.test(issue)) && issues.some((issue) => /does not name/.test(issue)) && issues.some((issue) => /numbers not in the item/.test(issue)));
});

function issueFixture(date = "2026-09-28") {
  const featured = { role: "featured", label: "Top News", type: "news", headline: "Lab ships <model> at 40% lower cost", body: "It is **fast**.\n\nHere's what changed:\n- Costs 40% less\n\nOne catch: preview only.",
    url: "https://lab.test/model", sources: ["https://lab.test/model", "https://github.com/lab/model"], traction: "1,762 HN points", topics: ["LLMs"], project: "Lab", publishedAt: null, facts: [] };
  const signal = { ...featured, role: "signal", label: "Signal", type: "repos", headline: "Repo adds a thing", body: null, url: "https://github.com/org/repo", sources: ["https://github.com/org/repo"], traction: null, topics: [] };
  const stories = storyRecords(date, [featured], [signal]);
  const draft = { version: 2, date, createdAt: `${date}T05:30:00.000Z`, subject: stories[0].headline, preview: "Lab ships model", intro: ["A hook. Two.", "Meanwhile, more.", "If you read one thing today: the model."], stories,
    pipeline: { candidates: 1, clusters: 1, shortlisted: 1, kept: 1, models: {}, usage: [], checks: {} } };
  return issueV2Schema.parse({ ...draft, markdown: issueMarkdown(draft) });
}

test("story records get stable ids and the archive Markdown splits into one block per story", () => {
  const issue = issueFixture();
  assert.match(issue.stories[0].id, /^s-[a-f0-9]{16}$/);
  assert.equal(issueFixture().stories[0].id, issue.stories[0].id);
  assert.deepEqual(issue.stories[0].sources.map(({ label }) => label), ["lab.test", "GitHub"]);
  assert.match(issue.markdown, /^# Lab ships <model> at 40% lower cost\n/);
  assert.deepEqual([...issue.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Lab ships <model> at 40% lower cost", "Signals"]);
  assert.match(issue.markdown, /1\. \[Repo adds a thing\]\(https:\/\/github\.com\/org\/repo\)/);
});

test("the email renders every story from the records, escapes text and greets by first name", () => {
  const { html, text, subject } = renderIssueEmail(issueFixture(), { firstName: "Ada Lovelace", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?email=a%40b.c", preferencesUrl: null });
  assert.equal(subject, "Lab ships <model> at 40% lower cost");
  assert.match(html, /Hey Ada,/);
  assert.match(html, /Lab ships &lt;model&gt; at 40% lower cost/);
  assert.doesNotMatch(html, /<model>/);
  assert.match(html, /<strong>fast<\/strong>/);
  assert.match(html, /<strong>One catch:<\/strong>/);
  assert.match(html, /1,762 HN points/);
  assert.match(html, /unsubscribe\?email=a%40b\.c/);
  assert.match(text, /^THE FORWARD PASS · Monday, September 28, 2026/);
  assert.match(renderIssueEmail(issueFixture(), { firstName: "<script>", unsubscribeUrl: "https://x.test", preferencesUrl: null }).html, /Hey there,/);
});

test("every email discloses that it is AI-generated at the top and in full at the bottom (AI Act Art. 50(4), (5))", () => {
  const { html, text } = renderIssueEmail(issueFixture(), { firstName: null, unsubscribeUrl: "https://x.test", preferencesUrl: null });
  assert.equal(AI_LABEL, "Daily AI-generated issue");
  assert.match(AI_DISCLOSURE, /written by AI/);
  const label = html.indexOf(AI_LABEL), greetingAt = html.indexOf("Hey there,"), disclosure = html.indexOf(AI_DISCLOSURE);
  assert.ok(label > 0 && label < greetingAt, "label must appear before the first story text");
  assert.ok(disclosure > greetingAt, "full disclosure sits in the footer");
  assert.ok(text.indexOf(AI_LABEL) < text.indexOf("Hey there,"));
  assert.ok(text.includes(AI_DISCLOSURE));
});

test("the Node step runner stores results, resumes without repeating work and retries failures", async () => {
  useStore(memoryStore());
  const log = () => {};
  let calls = 0;
  const first = await nodeSteps("job", { log }).run("step", {}, async () => { calls++; return { value: 1 }; });
  const again = await nodeSteps("job", { log }).run("step", {}, async () => { calls++; return { value: 2 }; });
  assert.deepEqual([first, again, calls], [{ value: 1 }, { value: 1 }, 1]);
  let attempts = 0;
  assert.equal(await nodeSteps("job", { log }).run("flaky", { retries: { limit: 2, delay: 1 } }, async () => { if (++attempts < 3) throw new Error("503"); return "ok"; }), "ok");
  await assert.rejects(nodeSteps("job", { log }).run("broken", { retries: { limit: 1, delay: 1 } }, async () => { throw new Error("bad"); }), /bad/);
});

function fakeResend({ contacts, optedOut = new Set(), failFirstSend = false }) {
  const sent = [];
  let failures = failFirstSend ? 1 : 0;
  return { sent, client: {
    contacts: {
      list: async () => ({ data: { data: contacts.map((email, i) => ({ id: `c${i}`, email, first_name: "Ada", unsubscribed: false })), has_more: false }, error: null }),
      get: async ({ id }) => ({ data: { id, email: contacts[Number(id.slice(1))], unsubscribed: false }, error: null }),
      topics: { list: async ({ email }) => ({ data: { data: [{ id: NEWSLETTER_TOPIC, subscription: optedOut.has(email) ? "opt_out" : "opt_in" }] }, error: null }) },
    },
    emails: { send: async (message, options) => {
      if (failures-- > 0) return { data: null, error: { message: "rate limited" } };
      sent.push({ to: message.to[0], key: options.idempotencyKey, subject: message.subject, headers: message.headers });
      return { data: { id: `e${sent.length}` }, error: null };
    } },
  } };
}

test("delivery stages the audience, sends once per reader, skips withdrawn consent and is idempotent on retry", async () => {
  delivery.pauseMs = 0;
  process.env.RESEND_SEGMENT_ID = "segment";
  process.env.NEWSLETTER_FROM = "The Forward Pass <news@theforwardpass.net>";
  process.env.PREFERENCES_SIGNING_SECRET = "x".repeat(32);
  const store = memoryStore();
  useStore(store);
  await createPrivateJson("issues/2026-09-28.json", issueFixture());
  const { client, sent } = fakeResend({ contacts: ["a@x.test", "b@x.test", "c@x.test"], optedOut: new Set(["c@x.test"]) });
  const log = () => {};
  const first = await deliverIssue(nodeSteps("deliver-1", { log }), { date: "2026-09-28" }, client);
  assert.deepEqual({ recipients: first.recipients, sent: first.sent }, { recipients: 2, sent: 2 });
  assert.deepEqual(sent.map(({ to }) => to), ["a@x.test", "b@x.test"]);
  assert.ok(sent.every(({ headers }) => headers["X-AI-Generated"] === "true"), "machine-readable AI marking (AI Act Art. 50(2))");
  assert.equal(new Set(sent.map(({ key }) => key)).size, 2);
  // A second delivery run (a retried Workflow) finds the ledger and sends nothing.
  const again = await deliverIssue(nodeSteps("deliver-2", { log }), { date: "2026-09-28" }, client);
  assert.deepEqual({ sent: again.sent, alreadySent: again.alreadySent }, { sent: 0, alreadySent: 2 });
  assert.equal(sent.length, 2);
  assert.ok(await readPrivateJson("delivery/2026-09-28/status.json"));
  assert.equal((await loadIssue("2026-09-28")).version, 2);
});

test("a send with no recorded outcome is retried with the same idempotency key", async () => {
  delivery.pauseMs = 0;
  useStore(memoryStore());
  await createPrivateJson("issues/2026-09-28.json", issueFixture());
  const { client, sent } = fakeResend({ contacts: ["a@x.test"], failFirstSend: true });
  const log = () => {};
  const first = await deliverIssue(nodeSteps("d1", { log }), { date: "2026-09-28" }, client);
  assert.equal(first.failed, 1);
  const retry = await deliverIssue(nodeSteps("d2", { log }), { date: "2026-09-28" }, client);
  assert.equal(retry.sent, 1);
  assert.equal(sent.length, 1);
});
