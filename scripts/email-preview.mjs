import { readFile, writeFile } from "node:fs/promises";
import { renderIssueHtml } from "../src/lib/email-html.ts";

// Usage: npm run email:preview -- issues/2026-09-23.md [out.html]
const [input, output = input.replace(/\.(md|txt)$/, "") + ".html"] = process.argv.slice(2);
if (!input) throw new Error("Usage: email:preview <issue.md> [out.html]");
const text = await readFile(input, "utf8");
await writeFile(output, renderIssueHtml(text, { unsubscribeUrl: "https://theforwardpass.net/unsubscribe?email=preview%40example.com" }));
console.log(output);
