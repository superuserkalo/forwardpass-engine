import assert from "node:assert/strict";
import test from "node:test";
import { readerFromProperties, tierFromProperties } from "../src/lib/reader-profile.ts";

// What the engine knows about a reader comes from their Resend contact: the plan the billing webhooks keep, and the reading profile
// the website saved at onboarding. A reader is never given more than the properties say, and a bad profile is no profile.
const NOW = Date.parse("2026-10-08T05:00:00Z");
const prop = (value) => ({ type: "string", value });
const profile = (extra = {}) => ({ firstName: "Ada", lastName: "L", role: "ML engineer", seniority: "Senior", company: "Acme", topics: ["Agents", "Retrieval"], content: ["News", "Models"], format: "Briefing", notes: "I care about evals and skip crypto", ...extra });
const contact = (properties) => Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, prop(value)]));

test("a reader's tier is what billing says: active plans, a trial that has not ended, and nothing else", () => {
  const tier = (properties) => tierFromProperties(contact(properties), NOW);
  assert.equal(tier({ personal_status: "active", personal_plan: "professional" }), "professional");
  assert.equal(tier({ personal_status: "active", personal_plan: "personal" }), "personal");
  assert.equal(tier({ personal_status: "trial", personal_trial_ends_at: "2026-10-09T00:00:00Z" }), "personal");
  assert.equal(tier({ personal_status: "trial", personal_trial_ends_at: "2026-10-08T04:59:59Z" }), "free", "a trial that ended");
  assert.equal(tier({ personal_status: "trial" }), "free", "a trial with no end is not one");
  assert.equal(tier({ personal_status: "trial", personal_trial_ends_at: "soon" }), "free");
  for (const status of ["canceled", "past_due", "", "ACTIVE"]) for (const plan of ["professional", "personal"]) assert.equal(tier({ personal_status: status, personal_plan: plan }), "free", `${status} ${plan}`);
  assert.equal(tier({ personal_status: "active", personal_plan: "enterprise" }), "free", "a plan this engine does not know");
  assert.equal(tier({}), "free");
  assert.equal(tierFromProperties(undefined, NOW), "free");
  assert.equal(tierFromProperties(null, NOW), "free");
});

test("the reading profile is read as the website saved it, trimmed to what the engine uses", () => {
  const reader = readerFromProperties(contact({ personal_status: "active", personal_plan: "personal", onboarding_profile: JSON.stringify(profile()) }), NOW);
  assert.equal(reader.tier, "personal");
  assert.deepEqual(reader.profile, { firstName: "Ada", topics: ["Agents", "Retrieval"], content: ["News", "Models"], format: "Briefing", notes: "I care about evals and skip crypto" });
});

test("a profile is cleaned: unknown topics and types are dropped, the note is cut, the format falls back to a briefing", () => {
  const read = (extra) => readerFromProperties(contact({ personal_status: "active", personal_plan: "personal", onboarding_profile: JSON.stringify(profile(extra)) }), NOW).profile;
  assert.deepEqual(read({ topics: ["Agents", "Astrology", "agents", "Open source", "Agents"] }).topics, ["Agents", "Open source"], "known topics only, once each, as the engine spells them");
  assert.deepEqual(read({ topics: ["agents", "OPEN SOURCE", " retrieval "] }).topics, ["Agents", "Open source", "Retrieval"], "spelled any way, kept as the engine spells them");
  assert.deepEqual(read({ content: ["Papers", "Podcasts"] }).content, ["Papers"]);
  assert.deepEqual(read({ content: ["Podcasts"] }).content, ["News", "Papers", "Models", "Repos"], "no type the engine knows means every type, not none");
  assert.equal(read({ format: "Links only" }).format, "Links only");
  assert.equal(read({ format: "Newspaper" }).format, "Briefing");
  assert.equal(read({ notes: "x".repeat(400) }).notes.length, 180);
  assert.equal(read({ notes: "  spaced \n  out  " }).notes, "spaced out");
  assert.equal(read({ firstName: "  Ada Lovelace " }).firstName, "Ada");
  assert.equal(read({ firstName: "<script>" }).firstName, null, "a name that is not a name is not used");
  assert.equal(read({ firstName: "" }).firstName, null);
});

test("a profile that cannot be used is no profile, and the reader is still a reader of their tier", () => {
  const read = (onboarding) => readerFromProperties(contact({ personal_status: "active", personal_plan: "professional", ...(onboarding === undefined ? {} : { onboarding_profile: onboarding }) }), NOW);
  for (const bad of [undefined, "", "not json", "[]", "null", JSON.stringify({ topics: [] }), JSON.stringify(profile({ topics: ["Astrology"] })), JSON.stringify(profile({ topics: "Agents" })), "x".repeat(20_000), JSON.stringify(profile({ notes: "x".repeat(20_000) }))]) {
    const reader = read(bad);
    assert.equal(reader.profile, null, String(bad).slice(0, 30));
    assert.equal(reader.tier, "professional");
  }
  assert.deepEqual(readerFromProperties(undefined, NOW), { tier: "free", profile: null });
});
