import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { preferencesLink } from "../src/lib/preference-link.ts";

test("reading-brief token stays in the URL fragment and matches the website verifier", () => {
  const prior = process.env.PREFERENCES_SIGNING_SECRET;
  process.env.PREFERENCES_SIGNING_SECRET = "k".repeat(32);
  try {
    const url = new URL(preferencesLink("reader@example.test", 1000));
    assert.equal(url.origin, "https://theforwardpass.net");
    assert.equal(url.search, "");
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    const [payload, signature] = token.split(".");
    const expected = createHmac("sha256", process.env.PREFERENCES_SIGNING_SECRET).update(`preferences:${payload}`).digest("base64url");
    assert.equal(signature, expected);
    assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).email, "reader@example.test");
  } finally {
    if (prior === undefined) delete process.env.PREFERENCES_SIGNING_SECRET;
    else process.env.PREFERENCES_SIGNING_SECRET = prior;
  }
});
