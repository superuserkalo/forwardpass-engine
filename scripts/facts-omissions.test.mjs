import assert from "node:assert/strict";
import test from "node:test";
import { factWithoutOmissions, verifyQuotes } from "../src/pipeline/facts.ts";

// A fact sheet is what a story is written from, and the facts are shown beside their quotes. A "fact" about what the page leaves out is not a
// fact about the development: on 9 October a chip story's sheet held "The article does not report AI-model capabilities, benchmarks, model
// parameters, context length, speed, software/API access, or a license", because the extractor is asked for a model launch's numbers and
// the issue's filter only knew "the source does not".
const PAGE = "GlobalFoundries and TSMC announced a manufacturing agreement. Under the agreement, GF will provide manufacturing service to TSMC, and add fabrication capacity at its Malta, New York facility. Volume production is expected to begin ramping in the first half of 2028.";

test("a fact about what the article leaves out is dropped, and the rest of the fact stands", () => {
  const { verified } = verifyQuotes([
    { fact: "The article does not report AI-model capabilities, benchmarks, model parameters, context length, speed, software/API access, or a license.", quote: "Under the agreement, GF will provide manufacturing service to TSMC" },
    { fact: "Volume production is expected to begin ramping in the first half of 2028. The article does not state the price.", quote: "Volume production is expected to begin ramping in the first half of 2028" },
    { fact: "GlobalFoundries will add fabrication capacity at its Malta, New York facility, but gives no figure for the investment.", quote: "add fabrication capacity at its Malta, New York facility" },
    { fact: "The announcement does not mention a start date for the second phase.", quote: "GlobalFoundries and TSMC announced a manufacturing agreement" },
    { fact: "It is unclear how much capacity the deal covers.", quote: "GlobalFoundries and TSMC announced a manufacturing agreement" },
  ], [PAGE]);
  assert.deepEqual(verified.map(({ fact }) => fact), [
    "Volume production is expected to begin ramping in the first half of 2028.",
    "GlobalFoundries will add fabrication capacity at its Malta, New York facility.",
  ]);
});

test("what a page says is not cut, even in the words of an omission", () => {
  const { verified } = verifyQuotes([
    { fact: "GlobalFoundries does not offer the part to other customers.", quote: "GF will provide manufacturing service to TSMC" },
    { fact: "The deal is not subject to export controls.", quote: "GlobalFoundries and TSMC announced a manufacturing agreement" },
  ], [PAGE]);
  assert.equal(verified.length, 2);
});

test("the fact filter is the one the signals use", () => {
  assert.equal(factWithoutOmissions("Opus 5.5 is an Opus model. The article does not provide pricing. It runs in Claude Code."), "Opus 5.5 is an Opus model. It runs in Claude Code.");
  assert.equal(factWithoutOmissions("The article does not provide pricing."), null);
});
