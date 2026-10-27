import { readFile, writeFile } from "node:fs/promises";
import { scoreSourceItem, shortlistSourceItems } from "../src/lib/source-collector.ts";
import { SOURCE_STREAMS } from "../src/lib/source-streams.ts";

// Replay saved raw candidates without network requests, model calls or issue writes.
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: node --import tsx scripts/source-ranking-replay.mjs INPUT.json OUTPUT.json");
const saved = JSON.parse(await readFile(input, "utf8"));
const previous = saved.streams ?? saved;
const now = new Date(saved.collectedAt);
if (!Array.isArray(previous.items) || !Array.isArray(previous.shortlist) || Number.isNaN(now.getTime())) throw new Error("Expected a dated source collection with items and shortlist");
const owners = new Map(SOURCE_STREAMS.map((stream) => [stream.id, stream.publisherId]));
const items = previous.items.map((item) => {
  const publisherId = owners.get(item.streamId);
  if (!publisherId) throw new Error(`Unmapped stream: ${item.streamId}`);
  return { ...item, publisherId, ...scoreSourceItem(item, now) };
});
const shortlist = shortlistSourceItems(items);
const counts = (rows, key) => {
  const result = {};
  for (const row of rows) { const value = key(row); result[value] = (result[value] ?? 0) + 1; }
  return result;
};
const stats = (rows) => ({ count: rows.length, publishers: counts(rows, (row) => owners.get(row.streamId)), categories: counts(rows, (row) => row.category) });
const beforeUrls = new Set(previous.shortlist.map((item) => item.url));
const afterUrls = new Set(shortlist.map((item) => item.url));
const compact = ({ title, source, score, scoreReasons, url }) => ({ title, source, score, scoreReasons, url });
const result = {
  input, collectedAt: saved.collectedAt, rawCount: items.length,
  before: stats(previous.shortlist), after: stats(shortlist),
  entered: shortlist.filter((item) => !beforeUrls.has(item.url)).map(compact),
  left: previous.shortlist.filter((item) => !afterUrls.has(item.url)).map(compact),
  shortlist,
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.info(JSON.stringify({ rawCount: result.rawCount, before: result.before, after: result.after, entered: result.entered.map((item) => item.title) }, null, 2));
