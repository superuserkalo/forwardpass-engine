/**
 * A text as its sentences. A full stop is the end of one only when whitespace follows it: not inside a number (39.2%, $0.10), a version or a
 * file name (5.5, E1.L), an address, and not after a single capital letter, as in "U.S.". The splitter that used to cut summaries matched runs
 * of text that end in a full stop and whitespace and skipped any text before the first such run, so "Haiku 5.5 now scores 39.2% on..."
 * began at "2% on...".
 */
export function splitSentences(text: string): string[] {
  return text.split(/(?<!\b[A-Z]\.)(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}
