import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore, useStore } from "../src/lib/private-store.ts";
import { entryKey } from "../src/lib/entry-key.ts";
import { localSignalService } from "../src/lib/signal-service.ts";
import { clusterCandidates, freshCandidates } from "../src/pipeline/candidates.ts";
import { CURSOR_KEY, dropCovered, isRepost, nextCandidates } from "../src/pipeline/signal-candidates.ts";
import { isTier1FirstParty } from "../src/pipeline/tier1.ts";
import { newStore, record } from "./signals-test-support.mjs";

// Signals read only the collection snapshots written since the last run, from both lanes, so a run every fifteen
// minutes costs a few small reads and not the whole day's.
const now = new Date("2026-10-03T10:00:00Z");

const item = (url, title, extra = {}) => ({ title, summary: "", url, publishedAt: "2026-10-03T08:00:00Z", source: "Lab", category: "news", dateKind: "published", firstSeenAt: "2026-10-03T08:05:00Z", ...extra });
const snapshot = (collectedAt, items) => ({ version: 2, collectedAt, items, attention: { measurements: [], candidates: [], health: [] }, health: [] });
const hn = (url, points) => ({ platform: "hacker-news", id: "9", url, measuredAt: "2026-10-03T09:00:00Z", previousMeasuredAt: null, elapsedHours: null, score: points, scoreDelta: null, scorePerHour: null, secondaryCount: points / 2, secondaryDelta: null });

const AGENT = "https://openai.com/index/a-new-agent-platform/";
const MODEL = "https://www.anthropic.com/news/model-launch";
const ROUTING = "https://blog.example.com/post-on-routers";
const agent = item(AGENT, "OpenAI launches a new agent platform for building production agents", { source: "OpenAI" });
const model = item(MODEL, "Anthropic releases a new model with a longer context window", { source: "Anthropic", publishedAt: "2026-10-03T09:10:00Z", firstSeenAt: "2026-10-03T09:12:00Z" });
// Not a tier-1 publisher, but a thread with enough points that attention alone ranks it above both launches.
const routing = item(ROUTING, "A deep dive on mixture of experts routing in production systems", { source: "Example Blog", publishedAt: "2026-10-03T07:30:00Z", attention: [hn(ROUTING, 600)] });
const stale = item("https://lab.test/old-post", "An old post about retrieval augmented generation evaluation", { publishedAt: "2026-10-01T12:00:00Z", firstSeenAt: "2026-10-01T12:05:00Z" });

function seed(extra = {}) {
  useStore(memoryStore({
    "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [agent, routing, stale]),
    "collection/fast/2026-10-03/0915.json": snapshot("2026-10-03T09:15:00Z", [{ ...agent, title: "OpenAI launches a new agent platform" }, model]),
    ...extra,
  }));
  return localSignalService(newStore());
}
const urls = (result) => result.candidates.map(({ cluster }) => cluster.lead.url);

test("a page that merely changed is a monitor and not an announcement, while a dated item that was seen again still is one", async () => {
  // Found reading what production would hand to triage: "OpenAI: News archive page changed" says nothing happened that can be quoted,
  // and the page it points at is a listing whose text would be read as if it were the announcement.
  const monitor = item("https://openai.com/news/", "OpenAI: News archive page changed", { source: "OpenAI", publishedAt: null, dateKind: "changed", summary: "OpenAI News | OpenAI All Filter Sort" });
  const readme = item("https://github.com/acme/tool", "Acme: Tool README changed", { source: "GitHub", publishedAt: null, dateKind: "changed" });
  const redated = item("https://openai.com/index/redated-post-about-agents/", "OpenAI launches a redated post about agents for developers", { source: "OpenAI", dateKind: "changed" });
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [monitor, readme, redated]) }));
  assert.deepEqual(urls(await nextCandidates(localSignalService(newStore()), now)), ["https://openai.com/index/redated-post-about-agents/"]);
});

test("an item that is only a link label with nothing else to judge it by is not worth a model's attention, but one with a summary is", async () => {
  // Stored snapshots still hold forty-one a day titled "View details"; the collector now titles them by their address.
  const bare = item("https://research.google/pubs/a-paper-nobody-can-judge/", "View details", { source: "Google Research", summary: "" });
  const spaced = item("https://research.google/pubs/another-paper-nobody-can-judge/", " Read   more. ", { source: "Google Research" });
  const described = item("https://research.google/pubs/a-paper-with-a-summary/", "View details", { source: "Google Research", summary: "We study how retrieval designs trade accuracy against cost in enterprise code migration." });
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [bare, spaced, described]) }));
  assert.deepEqual(urls(await nextCandidates(localSignalService(newStore()), now)), ["https://research.google/pubs/a-paper-with-a-summary/"]);
});

test("the fixtures are what the tests say they are", () => {
  assert.equal(isTier1FirstParty(agent), true);
  assert.equal(isTier1FirstParty(model), true);
  assert.equal(isTier1FirstParty(routing), false);
});

test("with no cursor every snapshot in the window is read, from both lanes, and the cursor is the newest one", async () => {
  const service = seed({ "collection/runs/2026-10-02/06.json": { broken: true } });
  const result = await nextCandidates(service, now);
  assert.equal(result.read, 2, "the snapshot from the day before is outside the window and is never opened");
  assert.equal(result.cursor, "2026-10-03T09:15:00.000Z");
  assert.deepEqual(result.invalid, []);
  assert.equal(urls(result).filter((url) => url === AGENT).length, 1, "one item seen by both lanes is one candidate");
  assert.ok(!urls(result).includes(stale.url), "an item older than the window is dropped");
  assert.deepEqual(result.candidates.map(({ urlKey }) => urlKey), result.candidates.map(({ cluster }) => entryKey(cluster.lead.url)), "the claim key is the lead's entry key");
});

test("only snapshots after the stored cursor, less the overlap, are read", async () => {
  const service = seed();
  await service.setValue(CURSOR_KEY, "2026-10-03T09:15:00.000Z");
  const overlapping = await nextCandidates(service, now, { overlapMinutes: 30 });
  assert.equal(overlapping.read, 1, "the 08:00 snapshot is before 08:45");
  assert.deepEqual(urls(overlapping).sort(), [AGENT, MODEL].sort(), "the routing post was only in the older snapshot");
  const wide = await nextCandidates(service, now, { overlapMinutes: 90 });
  assert.equal(wide.read, 2, "a wider overlap reaches back to 07:45");
  assert.equal((await nextCandidates(service, now, { overlapMinutes: 0 })).read, 1, "a snapshot written exactly at the cursor is read");
  await service.setValue(CURSOR_KEY, "2026-10-03T09:16:00.000Z");
  const caughtUp = await nextCandidates(service, now, { overlapMinutes: 0 });
  assert.deepEqual([caughtUp.read, caughtUp.candidates.length, caughtUp.cursor], [0, 0, "2026-10-03T09:16:00.000Z"], "nothing new leaves the cursor where it was");
});

test("by default a snapshot is read again for six hours after the cursor, long enough to retry a failed item", async () => {
  const service = seed();
  await service.setValue(CURSOR_KEY, "2026-10-03T09:15:00.000Z");
  assert.equal((await nextCandidates(service, now)).read, 2, "the 08:00 snapshot is within six hours of the cursor");
  await service.setValue(CURSOR_KEY, "2026-10-03T16:00:00.000Z");
  assert.equal((await nextCandidates(service, new Date("2026-10-03T16:15:00Z"))).read, 0, "but not for ever: at 16:00 the window starts at 10:00");
});

test("a title is a repost when it overlaps a headline at least 0.7 and has enough words to say so", () => {
  const published = ["Cohere releases Embed 5 with 85.8 on ViDoRe V3", "Meta publishes a new open weights vision language model"];
  assert.equal(isRepost("Cohere releases Embed 5 with 85.8 on ViDoRe V3 for retrieval", published), true);
  assert.equal(isRepost("Anthropic ships a longer context window for its newest model", published), false);
  assert.equal(isRepost("Embed 5", published), false, "two words overlap with anything about Embed");
  assert.equal(isRepost("Cohere releases Embed 5 with 85.8 on ViDoRe V3", []), false);
});

test("a snapshot that cannot be read is skipped and reported, and does not stop the run", async () => {
  const service = seed({ "collection/fast/2026-10-03/0930.json": { broken: true } });
  const result = await nextCandidates(service, now);
  assert.deepEqual(result.invalid, ["collection/fast/2026-10-03/0930.json"]);
  assert.equal(result.cursor, "2026-10-03T09:30:00.000Z", "the cursor moves past it, so it is not retried forever");
  assert.ok(urls(result).includes(AGENT) && urls(result).includes(MODEL));
});

test("an item that is claimed, published or already covered is not a candidate", async () => {
  const service = seed();
  assert.equal((await nextCandidates(service, now)).candidates.length, 3);
  await service.claim([entryKey(AGENT)], now.toISOString());
  assert.deepEqual(urls(await nextCandidates(service, now)).sort(), [MODEL, ROUTING].sort(), "claimed by another run");
  await service.publish(record(MODEL));
  assert.deepEqual(urls(await nextCandidates(service, now)), [ROUTING], "published");
  // A repost: another URL, the same event, worded as a headline we already published.
  const repost = seed();
  await repost.publish(record("https://openai.com/index/agent-platform-overview/", { headline: "OpenAI launches a new agent platform for building production agents today" }));
  assert.ok(!urls(await nextCandidates(repost, now)).includes(AGENT), "a title that is at least 0.7 similar to a recent headline is dropped before any model is paid for it");
  assert.ok(urls(await nextCandidates(repost, now)).includes(MODEL));
  const reported = await nextCandidates(seed(), now, { reportedUrls: new Set([entryKey(`${MODEL}?utm_source=x`)]) });
  assert.ok(!urls(reported).includes(MODEL), "a URL an issue already reported");
});

test("tier-1 first-party launches come first and survive the limit, whatever attention says", async () => {
  const service = seed();
  const all = await nextCandidates(service, now);
  assert.equal(clusterCandidates([agent, routing, model]).at(0).lead.url, ROUTING, "by score alone the discussion would lead");
  assert.deepEqual(urls(all).slice(0, 2).sort(), [AGENT, MODEL].sort());
  assert.equal(urls(all).at(2), ROUTING);
  assert.deepEqual(urls(await nextCandidates(service, now, { limit: 2 })).sort(), [AGENT, MODEL].sort());
  assert.equal((await nextCandidates(service, now, { limit: 0 })).candidates.length, 0);
});

test("the tier-1 publisher's own item leads its cluster, so what the tier-1 gate vouched for is what is published", async () => {
  // Someone's repository titled like the launch joins its cluster, and by the clustering's own rule it would lead it.
  const title = "OpenAI launches a new agent platform for building production agents";
  const imitation = item("https://github.com/evil/agent-platform-clone", title, { source: "GitHub", category: "new repository", firstSeenAt: "2026-10-03T08:01:00Z" });
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [imitation, { ...agent, title }]) }));
  const service = localSignalService(newStore());
  const { candidates } = await nextCandidates(service, now);
  assert.equal(candidates.length, 1, "one cluster");
  assert.equal(clusterCandidates([imitation, { ...agent, title }])[0].lead.url, "https://github.com/evil/agent-platform-clone", "by score alone the repository leads");
  assert.equal(candidates[0].cluster.lead.url, AGENT, "but the publisher's own item leads what is claimed, triaged, verified and published");
  assert.equal(candidates[0].urlKey, entryKey(AGENT), "and the claim key is its key");
  assert.equal(candidates[0].cluster.items.length, 2, "the repository is still part of the cluster, as a member");
});

test("a neighbour in the cluster cannot suppress the launch, unless it was already published", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const imitation = item("https://github.com/evil/agent-platform-clone", title, { source: "GitHub", category: "new repository", firstSeenAt: "2026-10-03T08:01:00Z" });
  const store = () => useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [imitation, { ...agent, title }]) }));
  // Someone seeds an item that titles itself like an announcement to come, and it is held, rejected or given up on.
  const key = entryKey(imitation.url);
  const setups = {
    claimed: async (s) => { await s.claim([key], "2026-10-03T09:50:00.000Z"); },
    rejected: async (s) => { await s.claim([key], "2026-10-03T09:00:00.000Z"); await s.release(key, "rejected", "2026-10-03T09:01:00.000Z"); },
    "failed a minute ago": async (s) => { await s.claim([key], "2026-10-03T09:50:00.000Z"); await s.release(key, "failed", "2026-10-03T09:55:00.000Z"); },
    "out of attempts": async (s) => { for (const at of ["08:00", "08:30", "09:00"]) { await s.claim([key], `2026-10-03T${at}:00.000Z`); await s.release(key, "failed", `2026-10-03T${at.slice(0, 3)}${at.slice(3) === "00" ? "01" : "31"}:00.000Z`); } },
  };
  for (const [state, setup] of Object.entries(setups)) {
    store();
    const service = localSignalService(newStore());
    await setup(service);
    assert.deepEqual(await service.unavailable([key], now.toISOString()), [key], `the neighbour really is unavailable (${state})`);
    const { candidates } = await nextCandidates(service, now);
    assert.deepEqual(candidates.map(({ cluster }) => cluster.lead.url), [AGENT], `the launch is still a candidate when the neighbour is ${state}`);
  }
  // The launch itself being held does stop it, and so does a signal that already covers a member.
  store();
  const held = localSignalService(newStore());
  await held.claim([entryKey(AGENT)], "2026-10-03T09:50:00.000Z");
  assert.equal((await nextCandidates(held, now)).candidates.length, 0, "the lead is claimed");
  // A signal for a neighbour that is not the publisher's does not cover the launch either: that would let anyone's earlier item
  // use up the story. One for the publisher's own page does.
  store();
  const decoy = localSignalService(newStore());
  await decoy.publish(record(imitation.url));
  assert.equal((await nextCandidates(decoy, now)).candidates.length, 1, "someone's repository was published, and the launch is still a candidate");
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, item("https://openai.com/research/agent-platform-details/", title, { source: "OpenAI", firstSeenAt: "2026-10-03T08:02:00Z" })]) }));
  const own = localSignalService(newStore());
  await own.publish(record("https://openai.com/research/agent-platform-details/"));
  assert.equal((await nextCandidates(own, now)).candidates.length, 0, "the publisher's own other page already has a signal, so the story is covered");
});

test("a community submission is never the publisher's, even when its address is", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const submission = item("https://openai.com/index/agent-platform-other-page/", title, { source: "Hacker News", category: "news", firstSeenAt: "2026-10-03T08:02:00Z" });
  assert.equal(isTier1FirstParty(submission), false, "a Hacker News item is no first-party launch");
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, submission]) }));
  const service = localSignalService(newStore());
  await service.claim([entryKey(submission.url)], "2026-10-03T09:00:00.000Z");
  await service.release(entryKey(submission.url), "rejected", "2026-10-03T09:01:00.000Z");
  assert.equal((await nextCandidates(service, now)).candidates.length, 1, "a rejected submission does not hold the launch");
  assert.equal((await nextCandidates(service, now, { reportedUrls: new Set([entryKey(submission.url)]) })).candidates.length, 1, "nor does one an issue reported");
  await service.publish(record(submission.url));
  assert.equal((await nextCandidates(service, now)).candidates.length, 1, "nor does a signal for it");
});

test("what an issue reported, and what was already said, covers a launch only through the publisher's own addresses", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const imitation = item("https://github.com/evil/agent-platform-clone", title, { source: "GitHub", category: "new repository", firstSeenAt: "2026-10-03T08:01:00Z" });
  const sibling = item("https://openai.com/research/agent-platform-details/", title, { source: "OpenAI", firstSeenAt: "2026-10-03T08:02:00Z" });
  const store = (...extra) => useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, ...extra]) }));
  const service = localSignalService(newStore());
  store(imitation, sibling);
  assert.equal((await nextCandidates(service, now, { reportedUrls: new Set([entryKey(imitation.url)]) })).candidates.length, 1, "an issue reported someone's repository, not the launch");
  assert.equal((await nextCandidates(service, now, { reportedUrls: new Set([entryKey(sibling.url)]) })).candidates.length, 0, "an issue reported the publisher's own page");
  assert.equal((await nextCandidates(service, now, { reportedUrls: new Set([entryKey(AGENT)]) })).candidates.length, 0, "or the launch itself");
  // The same for a headline already published: a third party's does not make the launch a repost, the publisher's does.
  store(imitation);
  const thirdParty = localSignalService(newStore());
  await thirdParty.publish(record("https://elsewhere.example.com/story", { headline: "OpenAI launches a new agent platform for building production agents today" }));
  assert.equal((await nextCandidates(thirdParty, now)).candidates.length, 1, "someone else's earlier headline");
  const ownEarlier = localSignalService(newStore());
  await ownEarlier.publish(record("https://openai.com/index/agent-platform-overview/", { headline: "OpenAI launches a new agent platform for building production agents today" }));
  assert.equal((await nextCandidates(ownEarlier, now)).candidates.length, 0, "the publisher's own earlier headline");
});

test("what an issue reported, and what was already said, covers any other cluster through every member", async () => {
  const title = "A deep dive on mixture of experts routing in production systems";
  const blog = item("https://blog.example.com/moe-routing", title, { source: "Example Blog" });
  const repo = item("https://github.com/someone/moe-routing", title, { source: "GitHub", category: "new repository" });
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [blog, repo]) }));
  const service = localSignalService(newStore());
  assert.equal((await nextCandidates(service, now, { reportedUrls: new Set([entryKey(blog.url)]) })).candidates.length, 0, "any member an issue reported");
  const said = localSignalService(newStore());
  await said.publish(record("https://elsewhere.example.com/story", { headline: "A deep dive on mixture of experts routing in production systems today" }));
  assert.equal((await nextCandidates(said, now)).candidates.length, 0, "and any headline already published");
});

test("the launch's own publisher's other items still count, so a story cannot dodge a rejection or its attempts by changing which item leads", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const sibling = item("https://openai.com/research/agent-platform-details/", title, { source: "OpenAI", firstSeenAt: "2026-10-03T08:02:00Z" });
  const other = item("https://blog.google/technology/ai/agent-platform-compared/", title, { source: "Google", firstSeenAt: "2026-10-03T08:03:00Z" });
  assert.equal(isTier1FirstParty(other), true, "the fixture is another tier-1 publisher's");
  const key = entryKey(sibling.url);
  const store = (extra) => useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, sibling, ...extra]) }));
  const setups = {
    claimed: async (s) => { await s.claim([key], "2026-10-03T09:50:00.000Z"); },
    rejected: async (s) => { await s.claim([key], "2026-10-03T09:00:00.000Z"); await s.release(key, "rejected", "2026-10-03T09:01:00.000Z"); },
    "out of attempts": async (s) => { for (const at of ["08:00", "08:30", "09:00"]) { await s.claim([key], `2026-10-03T${at}:00.000Z`); await s.release(key, "failed", `2026-10-03T${at.slice(0, 3)}${at.slice(3) === "00" ? "01" : "31"}:00.000Z`); } },
  };
  for (const [state, setup] of Object.entries(setups)) {
    store([]);
    const service = localSignalService(newStore());
    await setup(service);
    assert.deepEqual(await service.unavailable([key], now.toISOString()), [key], `the sibling really is unavailable (${state})`);
    assert.equal((await nextCandidates(service, now)).candidates.length, 0, `the same publisher's other page is ${state}, so the story is not taken up again under another lead`);
  }
  // Another tier-1 publisher's item is as trusted as the lead.
  store([other]);
  const service = localSignalService(newStore());
  await service.claim([entryKey(other.url)], "2026-10-03T09:50:00.000Z");
  assert.equal((await nextCandidates(service, now)).candidates.length, 0, "a tier-1 neighbour's claim holds the story, as well");
});

test("a page on the launch's own site counts even when it is not itself a launch", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const docs = item("https://openai.com/docs/agent-platform-overview/", title, { source: "OpenAI", category: "documentation", firstSeenAt: "2026-10-03T08:02:00Z" });
  assert.equal(isTier1FirstParty(docs), false, "the fixture is the publisher's page but not a launch");
  useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, docs]) }));
  const service = localSignalService(newStore());
  assert.equal((await nextCandidates(service, now)).candidates.length, 1);
  await service.claim([entryKey(docs.url)], "2026-10-03T09:50:00.000Z");
  assert.equal((await nextCandidates(service, now)).candidates.length, 0, "the publisher's own page is held, so the story is");
});

test("a forum or support page on the publisher's domain is not the publisher: it cannot suppress the launch", async () => {
  const title = "OpenAI launches a new agent platform for building production agents";
  const community = item("https://community.openai.com/t/agent-platform-launch/123", title, { source: "OpenAI Community", category: "news", firstSeenAt: "2026-10-03T08:02:00Z" });
  const nested = item("https://eu.community.openai.com/t/agent-platform-launch/124", title, { source: "OpenAI Community", category: "news", firstSeenAt: "2026-10-03T08:03:00Z" });
  const key = entryKey(community.url);
  for (const [name, neighbour] of [["a community forum", community], ["a nested community host", nested]]) {
    assert.equal(isTier1FirstParty(neighbour), false, `${name} is no launch`);
    useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [{ ...agent, title }, neighbour]) }));
    const service = localSignalService(newStore());
    await service.claim([entryKey(neighbour.url)], "2026-10-03T09:00:00.000Z");
    await service.release(entryKey(neighbour.url), "rejected", "2026-10-03T09:01:00.000Z");
    assert.deepEqual(await service.unavailable([entryKey(neighbour.url)], now.toISOString()), [entryKey(neighbour.url)], `${name} really is rejected`);
    assert.equal((await nextCandidates(service, now)).candidates.length, 1, `the launch is still a candidate when ${name} was rejected`);
  }
  assert.ok(key);
});

test("for a cluster that is no tier-1 launch the lead decides whether it is held, and a signal for any member covers it", async () => {
  const title = "A deep dive on mixture of experts routing in production systems";
  const blog = item("https://blog.example.com/moe-routing", title, { source: "Example Blog" });
  const repo = item("https://github.com/someone/moe-routing", title, { source: "GitHub", category: "new repository" });
  const store = () => useStore(memoryStore({ "collection/runs/2026-10-03/08.json": snapshot("2026-10-03T08:07:00Z", [blog, repo]) }));
  store();
  const service = localSignalService(newStore());
  const first = (await nextCandidates(service, now)).candidates;
  assert.equal(first.length, 1);
  assert.equal(first[0].cluster.lead.url, repo.url, "the repository leads, as a lab-like host, and the blog is a member");
  // With no tier-1 publisher in the story there is nobody whose own items can be trusted, so a neighbour's state says nothing:
  // a rejected member cannot suppress the story, and the lead's own state is what holds it.
  await service.claim([entryKey(blog.url)], "2026-10-03T09:00:00.000Z");
  await service.release(entryKey(blog.url), "rejected", "2026-10-03T09:01:00.000Z");
  assert.equal((await nextCandidates(service, now)).candidates.length, 1, "a member that was rejected does not hold the story back");
  await service.claim([entryKey(repo.url)], "2026-10-03T09:30:00.000Z");
  await service.release(entryKey(repo.url), "rejected", "2026-10-03T09:31:00.000Z");
  assert.equal((await nextCandidates(service, now)).candidates.length, 0, "the lead being rejected does");
  // A signal that exists for any member covers the story.
  store();
  const covered = localSignalService(newStore());
  await covered.publish(record(blog.url));
  assert.equal((await nextCandidates(covered, now)).candidates.length, 0, "a member already has a signal");
});

test("dropCovered keeps a short or unrelated title and drops a reposted or reported one", () => {
  const cluster = (url, title) => clusterCandidates([item(url, title)])[0];
  const published = [{ headline: "Cohere releases Embed 5 with 85.8 on ViDoRe V3", url: "https://news.test/earlier" }];
  const repost = cluster("https://news.test/a", "Cohere releases Embed 5 with 85.8 on ViDoRe V3 for retrieval");
  const other = cluster("https://news.test/b", "Meta publishes a new open weights vision language model");
  const short = cluster("https://news.test/c", "Embed 5");
  const reported = cluster("https://news.test/d?utm_source=x", "A sufficiently long title about something quite different");
  assert.deepEqual(dropCovered([repost, other, short, reported], published, new Set([entryKey("https://news.test/d")])), [other, short], "a title with only a couple of words is too thin to call a repost");
  assert.deepEqual(dropCovered([repost], [], new Set()), [repost], "nothing published, nothing covered");
});

test("the daily issue reads the fast lane's snapshots too, and an item both lanes saw once", async () => {
  seed();
  const { candidates, snapshots } = await freshCandidates("2026-10-03", now);
  assert.equal(snapshots, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.url).filter((url) => url === AGENT || url === MODEL).sort(), [AGENT, MODEL].sort());
  assert.ok(!candidates.some((candidate) => candidate.url === stale.url));
});
