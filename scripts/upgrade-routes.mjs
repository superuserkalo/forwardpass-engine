// Finds HTML catalog routes whose page advertises a working RSS or Atom feed.
//
//   node --import tsx scripts/upgrade-routes.mjs                probe every HTML page, write the proposals
//   node --import tsx scripts/upgrade-routes.mjs --apply        patch the catalog from the saved proposals
//   node --import tsx scripts/upgrade-routes.mjs --write        probe, then patch
//   --guess   for pages that advertise no feed (or cannot be fetched), try the conventional feed
//             paths; its proposals go to docs/route-feed-guesses.json
//   --only=host1,host2 limits the probe to those publishers
//
// Proposals go to docs/route-feed-upgrades.json with their evidence. Patching rewrites
// docs/source-catalog.json so each upgraded page reads its feed; run `npm run sources:registry`
// afterwards. Plain GETs only, one request at a time per origin, no model calls.
import { readFile, writeFile } from "node:fs/promises";
import { parseFeed } from "../src/lib/feed-finder.ts";
import { chooseFeed, extractFeedLinks, guessFeedLinks, upgradeTarget } from "../src/lib/feed-upgrade.ts";
import { fetchSameSite } from "../src/lib/safe-fetch.ts";
import { setDefaultPageLoader } from "../src/lib/source-evidence.ts";
import { publicPageLoader } from "../src/node/public-fetch.ts";

// A page's links are untrusted input, and this runs on a developer machine: every read goes through the loader
// that checks each address (and each redirect) against private ranges.
setDefaultPageLoader(publicPageLoader);

const CATALOG = new URL("../docs/source-catalog.json", import.meta.url);
const guess = process.argv.includes("--guess");
const PROPOSALS = new URL(guess ? "../docs/route-feed-guesses.json" : "../docs/route-feed-upgrades.json", import.meta.url);
const RECENT_DAYS = 180;
const apply = process.argv.includes("--apply");
const write = apply || process.argv.includes("--write");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7).split(",");

const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
// A page reads itself unless its fetchUrl already points somewhere else (a feed or an API).
const readsItself = (page) => !page.fetchUrl || page.fetchUrl === page.url;

// Public HTTPS only, redirects only within the publisher (or the catalog's owner host, for a page that moved), size and
// time capped. Any content type: parseFeed decides whether the body is a feed.
async function get(url, owner) {
  const page = await fetchSameSite(url, { timeoutMs: 20_000, maxBytes: 4_000_000, contentType: /./, trustedHosts: owner ? [owner] : [] });
  return page && { url: page.url, text: page.body };
}

async function probe(feedUrl) {
  const result = await get(feedUrl);
  const feed = result && parseFeed(result.text);
  if (!result || !feed) return null;
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const dated = feed.entries.filter(({ date }) => Number.isFinite(date));
  const recent = dated.filter(({ date }) => date >= since);
  return { url: result.url, kind: feed.kind, entries: feed.entries.length, recent: recent.length,
    latestAt: dated.length ? new Date(Math.max(...dated.map(({ date }) => date))).toISOString() : null, sampleTitles: recent.slice(0, 3).map(({ title }) => title) };
}

let proposals = [];
if (apply) {
  // The saved proposals, re-checked against the current rules.
  proposals = JSON.parse(await readFile(PROPOSALS, "utf8")).proposals.filter((p) => upgradeTarget(p.pageUrl, p.feed.url, p.host) === p.feed.url);
  console.log(JSON.stringify({ saved: proposals.length }));
} else {
  const pages = catalog.sources.flatMap((source) => source.pages.map((page) => ({ source, page })))
    .filter(({ source, page }) => page.format === "html" && readsItself(page) && (!only || only.includes(source.host)));
  console.error(`html pages to probe: ${pages.length}`);
  const tails = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < pages.length) {
      const { source, page } = pages[next++];
      const origin = new URL(page.url).origin;
      const run = (tails.get(origin) ?? Promise.resolve()).then(async () => {
        const html = await get(page.url, source.host);
        // A page that cannot be fetched may still serve its feed (Substack answers 429 to the page, not to /feed).
        const advertised = html ? extractFeedLinks(html.text, html.url).slice(0, 4) : [];
        const links = advertised.length ? advertised : guess ? guessFeedLinks(page.url) : [];
        // Only the publisher's own feeds are requested at all, and the address each ends at is checked again: a link
        // on a page is untrusted until the rule that would accept it has accepted it, and a redirect is part of the answer.
        const probes = (await Promise.all(links.filter((link) => upgradeTarget(page.url, link, source.host)).map(probe)))
          .filter((feed) => feed && upgradeTarget(page.url, feed.url, source.host));
        const chosen = chooseFeed(page.url, probes);
        const target = chosen && upgradeTarget(page.url, chosen.url, source.host);
        if (!chosen || !target) return;
        // A rule may point the page at a different feed (a forum's category feed); that one is probed too.
        const feed = target === chosen.url ? chosen : await probe(target);
        if (feed && feed.recent > 0) proposals.push({ host: source.host, publisher: source.publisher, label: page.label, pageUrl: page.url, feed });
      });
      tails.set(origin, run.catch(() => undefined));
      await run;
    }
  }));
  proposals.sort((a, b) => a.host.localeCompare(b.host) || a.pageUrl.localeCompare(b.pageUrl));
  await writeFile(PROPOSALS, `${JSON.stringify({ checkedOn: new Date().toISOString().slice(0, 10), recentDays: RECENT_DAYS, probed: pages.length, proposals }, null, 2)}\n`);
  console.log(JSON.stringify({ probed: pages.length, upgradable: proposals.length, distinctFeeds: new Set(proposals.map(({ feed }) => feed.url)).size }));
}

if (write) {
  const checkedOn = new Date().toISOString().slice(0, 10);
  const byPage = new Map(proposals.map((p) => [p.pageUrl, p]));
  let patched = 0;
  for (const source of catalog.sources) for (const page of source.pages) {
    const proposal = byPage.get(page.url);
    if (!proposal || page.format !== "html" || !readsItself(page)) continue;
    const { feed } = proposal;
    page.collectionNotes = `Reads the feed ${guess ? "found at a conventional path" : "this page advertises"} instead of extracting cards from HTML (route audit ${checkedOn}).${page.collectionNotes ? ` Earlier note: ${page.collectionNotes}` : ""}`;
    page.format = feed.kind;
    page.fetchUrl = feed.url;
    page.verification = "verified";
    page.evidenceUrl = feed.url;
    page.evidence = `${guess ? "Found at a conventional path" : "Advertised by the page"}: ${feed.entries} entries, ${feed.recent} in the last ${RECENT_DAYS} days, latest ${feed.latestAt?.slice(0, 10)}.`;
    patched++;
  }
  const formats = {};
  for (const source of catalog.sources) for (const page of source.pages) formats[page.format] = (formats[page.format] ?? 0) + 1;
  if (catalog.summary?.pageFormats) catalog.summary.pageFormats = formats;
  await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(JSON.stringify({ patched, pageFormats: formats }), "\ncatalog patched; run: npm run sources:registry");
}
