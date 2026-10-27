/**
 * Splits a published daily edition into the stories a reader can browse and upvote.
 * Numbered stories keep their position so ids and anchors stay stable:
 * `daily:<date>:<n>` for the nth numbered story, `daily:<date>:signal:<n>` for quick signals.
 */

export type EditionStory = {
  kind: "story" | "signal";
  index: number;
  title: string;
  dek: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
};

const NUMBERED = /^(\d{1,2})\s+[—–-]\s+(.+)$/;
const SECTION_LABEL = /^[A-Z][A-Z ]{3,}$/;
const PRIMARY_SOURCE = /^Primary source\s*→\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const SIGNAL = /^[•*-]\s+(.+?)\s+[—–-]\s+(https?:\/\/\S+)\s*$/;
const FIELD_LABELS = new Set(["What happened", "Why it matters"]);

function firstSentences(text: string, limit = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const sentenceEnd = cut.search(/[.!?](?=\s[A-Z])[^.!?]*$/);
  return sentenceEnd > 80 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, limit - 1).trimEnd()}…`;
}

function whatHappened(lines: string[]): string {
  const start = lines.findIndex((line) => line.trim() === "What happened");
  const from = start === -1 ? 0 : start + 1;
  const collected: string[] = [];
  for (const line of lines.slice(from)) {
    const trimmed = line.trim();
    if (FIELD_LABELS.has(trimmed) || PRIMARY_SOURCE.test(trimmed)) break;
    if (!trimmed && collected.length > 0) break;
    if (trimmed) collected.push(trimmed);
  }
  return firstSentences(collected.join(" "));
}

export function editionStories(markdown: string): EditionStory[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const stories: EditionStory[] = [];
  let section: "none" | "story" | "signals" | "other" = "none";
  let current: { title: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const source = current.lines.map((line) => PRIMARY_SOURCE.exec(line.trim())).find(Boolean);
    stories.push({
      kind: "story",
      index: stories.filter((story) => story.kind === "story").length,
      title: current.title,
      dek: whatHappened(current.lines),
      sourceUrl: source?.[2] ?? null,
      sourceLabel: source?.[1] ?? null,
    });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const numbered = NUMBERED.exec(trimmed);
    if (numbered?.[2] && !numbered[2].startsWith("http")) {
      flush();
      section = "story";
      current = { title: numbered[2].trim(), lines: [] };
      continue;
    }
    if (SECTION_LABEL.test(trimmed) && trimmed !== "THE FORWARD PASS") {
      flush();
      section = trimmed === "QUICK SIGNALS" ? "signals" : "other";
      continue;
    }
    if (section === "story" && current) {
      current.lines.push(line);
    } else if (section === "signals") {
      const signal = SIGNAL.exec(trimmed);
      if (signal?.[1] && signal[2]) {
        stories.push({
          kind: "signal",
          index: stories.filter((story) => story.kind === "signal").length,
          title: signal[1],
          dek: "",
          sourceUrl: signal[2],
          sourceLabel: null,
        });
      }
    }
  }
  flush();
  return stories;
}
