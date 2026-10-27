import { canonicalSourceUrl } from "./source-evidence.js";

// Changelogs, release notes and GitHub release lists put many entries on one page and tell them
// apart by anchor, so there the fragment is part of an item's identity. On any other page it is
// only a scroll position.
const ENTRY_PAGE = /(?:^|\/)(?:changelog|release-?notes|releases?|updates|what-?s-new)(?:\/|$)/i;

/** Identity of a published item: the canonical source URL, plus the entry anchor on pages that list many entries. */
export function entryKey(value: string): string {
  const key = canonicalSourceUrl(value);
  const { hash, pathname } = new URL(value);
  return hash.length > 1 && ENTRY_PAGE.test(pathname) ? `${key}${hash}` : key;
}
