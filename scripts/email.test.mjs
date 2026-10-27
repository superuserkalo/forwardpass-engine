import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderIssueEmail, subjectLine } from "../src/delivery/email.ts";
import { ISSUE, OPTIONS } from "./email-fixture.mjs";

// The shared issue's email is what every free reader gets, and what a paying reader gets when their own edition cannot be built.
// It must not change by a byte when the pieces it shares with the personal edition are lifted out of it.
const golden = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("the shared issue's email is byte for byte what it was", () => {
  const out = renderIssueEmail(ISSUE, OPTIONS);
  assert.equal(out.html, golden("issue-email.html"));
  assert.equal(out.text, golden("issue-email.txt"));
  assert.deepEqual({ subject: out.subject, preheader: out.preheader }, JSON.parse(golden("issue-email.json")));
});

test("a reader with no name or brief link gets the same email without them", () => {
  const out = renderIssueEmail(ISSUE, { firstName: null, unsubscribeUrl: OPTIONS.unsubscribeUrl, preferencesUrl: null });
  assert.match(out.html, /Hey there,/);
  assert.doesNotMatch(out.html, /Edit your reading brief/);
  assert.match(out.html, /Daily AI-generated issue/);
});

test("a subject line is cut at a word and marked, never in the middle of one, and never longer than its limit", () => {
  assert.equal(subjectLine("A short subject", 40), "A short subject");
  assert.equal(subjectLine("Exactly twenty chars", 20), "Exactly twenty chars", "at the limit is not over it");
  const original = "OpenAI expands GPT-6 with Intelligent UI responses combining text, visuals and interactive controls";
  for (const max of [40, 51, 52, 53, 60, 70, 75, 98]) {
    const cut = subjectLine(original, max);
    assert.ok(cut.length <= max, `${max}: ${cut.length}`);
    assert.ok(cut.endsWith("…"), cut);
    const kept = cut.slice(0, -1);
    assert.ok(original.startsWith(kept) && /^[,;:]?\s/.test(original.slice(kept.length)), `a whole word was the last: "${cut}"`);
    assert.doesNotMatch(kept, /[,;:\s-]$/, `no dangling punctuation: "${cut}"`);
  }
  assert.equal(subjectLine(original, 60), "OpenAI expands GPT-6 with Intelligent UI responses…");
  assert.equal(subjectLine("aaaaaaaaaa bb ccc", 14), "aaaaaaaaaa bb…", "when the limit falls just after a word, that word stays");
  const long = subjectLine("x".repeat(300), 120);
  assert.deepEqual([long.length, long.endsWith("…")], [120, true], "one long word is cut where it must be");
  const early = subjectLine(`A ${"y".repeat(300)}`, 120);
  assert.deepEqual([early.length, early.startsWith("A y")], [120, true], "a space near the start is not a place to cut: nothing would be left");
});
