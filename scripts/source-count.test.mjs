import assert from "node:assert/strict";
import test from "node:test";
import { countSources } from "../src/lib/source-count.ts";

test("counts every stream and each owning publisher once", () => {
  const counts = countSources([{ publisherId: "openai" }, { publisherId: "openai" }, { publisherId: "anthropic" }]);
  assert.deepEqual(counts, { sources: 3, publishers: 2 });
});

test("an empty catalog counts as zero", () => {
  assert.deepEqual(countSources([]), { sources: 0, publishers: 0 });
});
