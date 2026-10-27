// Text from outside is cleaned of the characters nobody can see. The checks on it (is this a request to a model? does this quote appear on the
// page?) read it as a person would, with invisible characters taken out, but a model can read some of them: Unicode "tag" characters spell
// ASCII that no one sees, and zero-width and variation-selector characters can carry it too. A check that ignores them and a model that reads
// them disagree about what the text says. Taken out where the text comes in, what is checked, stored and sent to a model is what a reader sees.

/**
 * Whole Unicode categories, not only a list that misses a character, and the blocks that hold the invisible ones whole, so that a code point in them
 * with no character yet is removed too: format characters (soft hyphen, zero-width and direction marks, invisible operators,
 * tag characters), control characters other than the whitespace ones, private-use and surrogate code points. Besides them the few marks and fillers
 * that draw nothing but are letters or combining marks: the grapheme joiner, the Hangul and Khmer fillers, Mongolian and other variation selectors,
 * and the blank Braille cell.
 */
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}\u0000-\u0008\u000E-\u001F\u007F-\u009F\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/** The text with the characters nobody can see taken out. Letters of every script, digits, punctuation, tabs and line breaks are left as they are. */
export const visibleText = (text: string): string => text.replace(HIDDEN, "").replace(/[\u2028\u2029]/g, "\n");
