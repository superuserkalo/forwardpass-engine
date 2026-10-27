import assert from "node:assert/strict";
import test from "node:test";
import { splitSentences } from "../src/pipeline/sentences.ts";

// A summary is cut at a sentence. A full stop inside a number, a version or a name is not the end of one, and nothing before the first
// real full stop may go missing: the splitter the personal editions used began "Haiku 5.5 now scores 39.2% on the same test." at "2% on the same test."
test("a full stop inside a number, a version, a file or a name does not end a sentence", () => {
  assert.deepEqual(splitSentences("Haiku 5.5 now scores 39.2% on the same test. It costs $0.10 per million tokens."), ["Haiku 5.5 now scores 39.2% on the same test.", "It costs $0.10 per million tokens."]);
  assert.deepEqual(splitSentences("Kioxia unveils E1.L SSDs with up to 122.88TB of capacity. They ship in 2027."), ["Kioxia unveils E1.L SSDs with up to 122.88TB of capacity.", "They ship in 2027."]);
  assert.deepEqual(splitSentences("The U.S. Commerce Department issued the rule. It takes effect on Monday."), ["The U.S. Commerce Department issued the rule.", "It takes effect on Monday."]);
  assert.deepEqual(splitSentences("Run pip install vllm==0.31.0 first. Then start the server at localhost:8000."), ["Run pip install vllm==0.31.0 first.", "Then start the server at localhost:8000."]);
});

test("question and exclamation marks end a sentence, and text with no end is one sentence", () => {
  assert.deepEqual(splitSentences("Is HBM4 sold out? Yes! Through 2027."), ["Is HBM4 sold out?", "Yes!", "Through 2027."]);
  assert.deepEqual(splitSentences("No full stop at the end"), ["No full stop at the end"]);
  assert.deepEqual(splitSentences("   "), []);
  assert.deepEqual(splitSentences("One.   Two.\n\nThree."), ["One.", "Two.", "Three."]);
});
