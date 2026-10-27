import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrivateJson, useStore } from "../src/lib/private-store.ts";
import { localStore } from "../src/node/store.ts";
import { recentHeadlines } from "../src/pipeline/candidates.ts";
import { ISSUE } from "./email-fixture.mjs";

// The editor is shown what the last issues ran, so that an event is not reported again from an outlet in another language.
const dated = (date, headlines) => ({ ...ISSUE, date, stories: headlines.map((headline, i) => ({ ...ISSUE.stories[0], id: `s-${String(i + 1).padStart(16, "0")}`, headline, position: i })) });

test("the headlines of the last two published issues, newest first", async () => {
  useStore(localStore(mkdtempSync(join(tmpdir(), "recent-"))));
  for (const [date, headlines] of [["2026-10-07", ["Old one"]], ["2026-10-08", ["Eight A", "Eight B"]], ["2026-10-09", ["Nine A"]]]) {
    await createPrivateJson(`issues/${date}.json`, dated(date, headlines));
    await createPrivateJson(`published/daily/${date}.json`, { version: 2, kind: "daily", date, publishedAt: `${date}T06:00:00.000Z` });
  }
  // A draft that was never published is not what readers were told.
  await createPrivateJson("issues/2026-10-10.json", dated("2026-10-10", ["A draft"]));
  assert.deepEqual(await recentHeadlines("2026-10-11"), ["Nine A", "Eight A", "Eight B"]);
  assert.deepEqual(await recentHeadlines("2026-10-09"), ["Eight A", "Eight B", "Old one"], "only issues before the day");
  assert.deepEqual(await recentHeadlines("2026-10-11", 1), ["Nine A"]);
  assert.deepEqual(await recentHeadlines("2026-10-07"), []);
});
