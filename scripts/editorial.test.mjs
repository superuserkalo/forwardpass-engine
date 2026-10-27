import assert from "node:assert/strict";
import { test } from "node:test";
import { deepDiveMarkdown, scrubSections, sourceCommands, verifiedSteps } from "../src/pipeline/deep-dive.ts";
import { monthData, summarizeAttention } from "../src/pipeline/monthly-report.ts";
import { createPrivateJson, memoryStore, readPrivateJson, useStore } from "../src/lib/private-store.ts";

const step = (command, needs = "nothing") => ({ label: "Install", command, needs, note: "" });

test("Try it keeps only commands copied from a captured source", () => {
  const corpus = "Install it:\n\n    curl -fsSL https://pi.dev/install.sh |   sh\n\nThen run pi --help.";
  const { kept, dropped } = verifiedSteps([step("curl -fsSL https://pi.dev/install.sh | sh"), step("pip install pi-agent"), step("pi --help")], corpus);
  assert.deepEqual(kept.map(({ command }) => command), ["curl -fsSL https://pi.dev/install.sh | sh", "pi --help"]);
  assert.deepEqual(dropped, ["pip install pi-agent"]);
});

test("the scrub drops confidently unsupported sentences and numbers no source has", () => {
  const sections = [{ heading: "What shipped", markdown: `Pi 1.0 ships Codemode and native MCP. It is the fastest harness on the market. ${"Filler words keep this section long enough to stay. ".repeat(4)}It costs $19 a month.` }];
  const verdicts = [{ text: "It is the fastest harness on the market.", verdict: "unsupported", confidence: 0.9 }];
  const { sections: kept, removed } = scrubSections("Pi 1.0 is out for everyone today.", sections, verdicts, new Set(["1.0"]));
  assert.match(kept[0].markdown, /^Pi 1\.0 ships Codemode and native MCP\./);
  assert.deepEqual(removed, ["It is the fastest harness on the market.", "It costs $19 a month."]);
});

test("Try it says what each step needs and that nothing was run", () => {
  const draft = { title: "t".repeat(12), dek: "d".repeat(40), sections: [{ heading: "What shipped", markdown: "Body." }],
    tryIt: { intro: "Start locally.", steps: [step("pi --help"), { ...step("export CLOUDFLARE_API_TOKEN=..."), needs: "api-key", note: "a Cloudflare API token" }] } };
  const markdown = deepDiveMarkdown(draft, ["https://earendil.com/posts/pi-1-0/"]);
  assert.match(markdown, /\*\*1\. Install\*\* · Runs locally, no account needed/);
  assert.match(markdown, /\*\*2\. Install\*\* · Needs an API key: a Cloudflare API token\n```bash\nexport/);
  const request = deepDiveMarkdown({ ...draft, tryIt: { intro: "", steps: [{ ...step("POST https://api.example.com/run"), needs: "api-key", note: "Needs a token." }] } }, []);
  assert.match(request, /Needs an API key: a token\n```\nPOST/);
  assert.match(markdown, /We have not run them\./);
  assert.match(markdown, /## Sources\n\n- <https:\/\/earendil\.com\/posts\/pi-1-0\/>/);
});

test("attention is summarised per day and the month's tables are computed by code", async () => {
  useStore(memoryStore());
  const metric = (platform, id, url, score, secondaryCount, at) => ({ platform, id, url, measuredAt: at, previousMeasuredAt: null, elapsedHours: null, score, scoreDelta: null, scorePerHour: null, secondaryCount, secondaryDelta: null });
  const snapshot = (hour, stars, points) => ({
    collectedAt: `2026-10-02T${hour}:00:00Z`,
    items: [{ title: "org/agent: an agent harness", summary: "", url: "https://github.com/org/agent", publishedAt: null, source: "GitHub", category: "repos" }],
    attention: {
      measurements: [metric("github", "org/agent", "https://github.com/org/agent", stars, 10, `2026-10-02T${hour}:00:00Z`), metric("hacker-news", "1", "https://lab.example/llm", points, 40, `2026-10-02T${hour}:00:00Z`), metric("hacker-news", "2", "https://cooking.example", 900, 5, `2026-10-02T${hour}:00:00Z`)],
      candidates: [{ title: "New LLM tops coding benchmark", summary: "", url: "https://lab.example/llm", publishedAt: null, source: "Hacker News", category: "news" }, { title: "Sourdough at home", summary: "", url: "https://cooking.example", publishedAt: null, source: "Hacker News", category: "news" }],
    },
  });
  await createPrivateJson("collection/runs/2026-10-02/00.json", snapshot("00", 1000, 120));
  await createPrivateJson("collection/runs/2026-10-02/12.json", snapshot("12", 1600, 340));
  assert.deepEqual(await summarizeAttention("2026-10-02"), { snapshots: 2, repos: 1, threads: 2 });
  const day = await readPrivateJson("reports/attention/2026-10-02.json");
  assert.deepEqual(day.github["org/agent"], { url: "https://github.com/org/agent", title: "org/agent: an agent harness", first: 1000, last: 1600, forks: 10 });
  const data = await monthData("2026-10");
  assert.deepEqual(data.repos, [{ name: "org/agent", url: "https://github.com/org/agent", title: "org/agent: an agent harness", starsGained: 600, stars: 1600 }]);
  assert.deepEqual(data.threads.map(({ title, points }) => [title, points]), [["New LLM tops coding benchmark", 340]]);
});

test("command lines are taken from the sources with line continuations joined", () => {
  const text = "Call it like this.\n\ncurl https://api.example.com/run \\\n  -H \"Authorization: Bearer $TOKEN\" \\\n  -d '{\"model\":\"clef\"}'\n\nPOST https://api.example.com/run\n\nnpm install @earendil-works/pi-ai";
  assert.deepEqual(sourceCommands([text]), ["curl https://api.example.com/run -H \"Authorization: Bearer $TOKEN\" -d '{\"model\":\"clef\"}'", "npm install @earendil-works/pi-ai"]);
});

test("a command split over highlighted lines is rebuilt, including a quoted JSON body", () => {
  const text = ["curl https://api.example.com/run \\\\", "-X POST \\\\", "-H \"Authorization: Bearer $TOKEN\" \\\\", "-d '{", "\"model\": \"clef\"", "}'", "That returns probabilities."].join("\n\n");
  assert.deepEqual(sourceCommands([text]), [`curl https://api.example.com/run -X POST -H "Authorization: Bearer $TOKEN" -d '{ "model": "clef" }'`]);
});
