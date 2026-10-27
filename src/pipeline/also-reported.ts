import type { Candidate } from "../lib/schemas.js";
import { looksLikeInstruction } from "./signal-writing.js";

// How the other outlets headlined the same story, shown to the triage and editor models: the lead's own page may say less (Samsung's earnings
// page gives numbers, the FT's headline says "on AI chip demand"). They are written by strangers, so they are data: a headline that addresses a
// model is not shown, control characters and line breaks are folded to spaces, and one that runs on is dropped rather than cut.
const MAX_CHARS = 140;
const folded = (title: string): string => title.normalize("NFKC");
/** One line: control and invisible characters become spaces. This is what a model is shown. */
const clean = (title: string): string => folded(title).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
/** The same with those characters removed, which is how a model may read a word that was split by one. */
const joined = (title: string): string => folded(title).replace(/[\p{Cc}\p{Cf}]+/gu, "");
/** The detector reads text as it is written, as it is shown and as it reads once split words are rejoined: a headline passes only if all three do. */
const addressesModel = (title: string): boolean => looksLikeInstruction(title) || looksLikeInstruction(clean(title)) || looksLikeInstruction(joined(title));

/** Up to three headlines for the story that are not the lead's own, once each. */
export function alsoReported(items: readonly Pick<Candidate, "title">[], leadTitle: string): string[] {
  const lead = clean(leadTitle);
  const titles = items.filter((item) => !addressesModel(item.title)).map((item) => clean(item.title)).filter((title) => title && title !== lead && title.length <= MAX_CHARS);
  return [...new Set(titles)].slice(0, 3);
}
