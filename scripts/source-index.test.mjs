import assert from "node:assert/strict";
import test from "node:test";
import { htmlIndex } from "../src/lib/source-index.ts";
import { isVagueTitle } from "../src/lib/vague-title.ts";

// Found by reading what the signals pipeline would be handed from production: forty-one items a day from one publications
// page titled "View details". Its cards link each paper twice, by the title and by a button, and the button replaced the title.
const stream = { id: "lab-pubs", publisher: "Lab", publisherId: "lab", section: "Publications", category: "research", kind: "html-news", url: "https://lab.test/pubs/" };
const card = (slug, title, button = "View details", summary = "") => `<div class="row-card"><div class="row-card__container"><div class="row-card__body">
  <a class="row-card__heading glue-link" href=https://lab.test/pubs/${slug}/ >
    ${title}
  </a>${summary ? `<p>${summary}</p>` : ""}</div>
  <div class="row-card__cta"><a class="glue-button" href="https://lab.test/pubs/${slug}/"><span class="js-gt-item-id">${button}</span></a></div></div></div>`;
const page = (...cards) => `<html><body><main>${cards.join("\n")}</main></body></html>`;
const titles = (records) => records.map((record) => record.title);

test("a card that links its page by its title and again by a button is titled by its title", () => {
  const records = htmlIndex(stream, page(
    card("when-android-apps-request-location", "When Android Apps Request Location with a Reason", "View details"),
    card("grounding-ai-agents-in-contracts", "Grounding AI Agents in Contracts: An Empirical Evaluation", "Read more"),
  ));
  assert.deepEqual(titles(records), ["When Android Apps Request Location with a Reason", "Grounding AI Agents in Contracts: An Empirical Evaluation"]);
});

test("a button that repeats the link of a card with a plain title anchor does not replace it either", () => {
  const body = `<html><body><main><li class="post"><h3><a href="https://lab.test/pubs/graph-rag/">Graph RAG in Enterprise Code Migration</a></h3><p>A study of two retrieval designs.</p>
    <span class="post-cta"><a href="https://lab.test/pubs/graph-rag/">Read more</a></span></li></main></body></html>`;
  const [record] = htmlIndex(stream, body);
  assert.equal(record.title, "Graph RAG in Enterprise Code Migration");
  assert.equal(record.description, "A study of two retrieval designs.", "and keeps its summary");
});

test("it makes no difference whether the button comes before the title or after it", () => {
  const body = `<html><body><main><article>
    <a href="https://lab.test/pubs/graph-rag-in-enterprise-code-migration/">Learn more</a>
    <h3><a href="https://lab.test/pubs/graph-rag-in-enterprise-code-migration/">Graph RAG in Enterprise Code Migration</a></h3>
  </article></main></body></html>`;
  assert.deepEqual(titles(htmlIndex(stream, body)), ["Graph RAG in Enterprise Code Migration"]);
});

test("a link with only a label for text is titled by its address, and one with nothing to say is left out", () => {
  const body = `<html><body><main>
    <li><a href="https://lab.test/pubs/beyond-vector-similarity-hierarchical-graph-rag/">View details</a></li>
    <li><a href="https://lab.test/pubs/x/">View details</a></li>
  </main></body></html>`;
  // The first card's own anchor is the first link in it, so it is read as a title; the label stands for the address.
  assert.deepEqual(titles(htmlIndex(stream, body)), ["beyond vector similarity hierarchical graph rag"]);
});

test("a real title that merely starts with a label is not mistaken for one", () => {
  const records = htmlIndex(stream, page(card("read-more-about-it", "Read more, remember more: retrieval for agents", "View details")));
  assert.deepEqual(titles(records), ["Read more, remember more: retrieval for agents"]);
});

test("what counts as a label rather than a title", () => {
  for (const label of ["View details", "view details", "  View   details ", "View details →", "Read more.", "Learn more", "Learn more »", "Read the article", "Continue reading", "See more", "Click here", "Details", "More", "Watch now", "Read paper", "View publication", "News", "Update", "Untitled", "Overview", "Changelog"]) assert.equal(isVagueTitle(label), true, label);
  for (const title of ["Introducing Model 5.5", "The Agent Said It Was Done. The Database Disagreed.", "Ling 3.1 Flash", "Read more, remember more: retrieval for agents", "Details of the 2026 outage", "News from the Lab: a new model", "", "GPT-6"]) assert.equal(isVagueTitle(title), false, JSON.stringify(title));
});
