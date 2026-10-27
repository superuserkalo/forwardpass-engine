// The language a source is written in, when it is not English. It is decided in code from the script of the source's own title, never by a
// model, because a reader is told by it that what they are shown was written up in English from a page in another language.

export type Language = "Chinese" | "Korean" | "Japanese";

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/g;
const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;
/** Below this share of a title's letters in another script, the title is English with a word or two of that script in it. */
const MIN_SHARE = 0.3;

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/**
 * Chinese, Korean or Japanese by the script a title is written in, or null for English. Han characters alone are Chinese, unless the site is
 * a Japanese or Korean one, where they are kanji and hanja.
 */
export function languageOf(title: string, url?: string): Language | null {
  const hangul = count(title, HANGUL), kana = count(title, KANA), han = count(title, HAN);
  const other = hangul + kana + han;
  if (!other || other / (other + count(title, LATIN)) < MIN_SHARE) return null;
  if (hangul) return "Korean";
  if (kana) return "Japanese";
  let host = "";
  try { host = new URL(url ?? "").hostname; } catch { /* no site to go by */ }
  return host.endsWith(".jp") ? "Japanese" : host.endsWith(".kr") ? "Korean" : "Chinese";
}

/** The description is looked at as far as this, which is enough to tell. */
const DESCRIPTION_CHARS = 300;

/**
 * The language a candidate is written in: its title's, or else its description's. A story can have an English title over a page in Chinese,
 * and what a reader is shown was then written up from a translation just the same.
 */
export function languageOfCandidate({ title, summary, url }: { title: string; summary?: string; url?: string }): Language | null {
  return languageOf(title, url) ?? (summary ? languageOf(summary.slice(0, DESCRIPTION_CHARS), url) : null);
}

/** A story's attention number with the note that it was read in another language in front of it, or the number alone when it was not. */
export function translatedTraction(lead: { title: string; summary?: string; url: string }, traction: string | null): string | null {
  const language = languageOfCandidate(lead);
  if (!language) return traction;
  return traction ? `translated from ${language} · ${traction}` : `translated from ${language}`;
}
