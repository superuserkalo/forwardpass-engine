import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_HOURS, MAX_BROWSER_ROUTES } from "../src/collect/browser.ts";

// Routes that block plain HTTP (45 of them, including first-party pages) were read through the
// browser only at 04:00 and 16:00 UTC, so a post on one of them waited up to 12 hours.

test("blocked routes are read through the browser every four hours, on the hours the collection runs", () => {
  assert.deepEqual([...BROWSER_HOURS].sort(), ["00", "04", "08", "12", "16", "20"]);
  for (const hour of BROWSER_HOURS) assert.equal(Number(hour) % 2, 0, `${hour}:00 is a collection hour (the cron runs every two hours)`);
  assert.ok(MAX_BROWSER_ROUTES >= 60);
});
