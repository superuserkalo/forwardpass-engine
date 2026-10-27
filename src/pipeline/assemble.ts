import { storyId, type IssueV2, type StoryRecord } from "../lib/issue.js";
import { canonicalSourceUrl } from "../lib/source-evidence.js";

// Code, not the model, assembles the issue: story records with stable IDs first, then the
// archive Markdown derived from them. The email is rendered from the same records.

export function sourceLabel(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host === "x.com" || host === "twitter.com" ? "X post" : host === "news.ycombinator.com" ? "HN discussion" : host === "arxiv.org" ? "arXiv paper"
    : host === "github.com" ? "GitHub" : host === "huggingface.co" ? "Hugging Face" : host;
}

const canonical = (url: string) => { try { return canonicalSourceUrl(url); } catch { return url; } };

export type StoryInput = Omit<StoryRecord, "id" | "position" | "sources"> & { sources: string[] };

export function storyRecords(date: string, featured: StoryInput[], signals: StoryInput[]): StoryRecord[] {
  const record = (input: StoryInput, position: number): StoryRecord => {
    const sources = [...new Set([...input.sources, input.url].map(canonical))];
    return { ...input, id: storyId(date, canonical(input.url)), position, sources: sources.map((url) => ({ label: sourceLabel(url), url })) };
  };
  return [...featured.map((story, i) => record(story, i)), ...signals.map((story, i) => record(story, i))];
}

/** Archive Markdown: one `## Headline` block per featured story and a Signals list, which the website's parser splits. */
export function issueMarkdown(issue: Pick<IssueV2, "subject" | "preview" | "intro" | "stories">): string {
  const featured = issue.stories.filter(({ role }) => role === "featured");
  const signals = issue.stories.filter(({ role }) => role === "signal");
  const blocks = featured.map((story) => [
    `## ${story.headline}`,
    `**${story.label}**${story.traction ? ` · ${story.traction}` : ""}`,
    story.body ?? "",
    `Sources: ${story.sources.map(({ label, url }) => `[${label}](${url})`).join(" · ")}`,
  ].filter(Boolean).join("\n\n"));
  const signalBlock = signals.length
    ? `## Signals\n\n${signals.map((story, i) => `${i + 1}. [${story.headline}](${story.url})${story.traction ? ` · ${story.traction}` : ""}`).join("\n")}`
    : "";
  return [`# ${issue.subject}`, `_${issue.preview}_`, ...issue.intro, ...blocks, signalBlock].filter(Boolean).join("\n\n") + "\n";
}

export function readTime(text: string): string {
  const words = text.replace(/\(https?:\/\/\S+\)/g, "").split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(60, Math.round(words / 200 * 60));
  return `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
}
