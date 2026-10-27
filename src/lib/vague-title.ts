// Words that label a link or a page and say nothing about what it is. A title that is only one cannot be a headline, cannot be
// told from the next one, and on a card that links its page twice must never replace the title the card has.

const LABELS = new Set([
  "view details", "view detail", "view more", "view all", "view post", "view article", "view publication", "view paper", "view page", "view",
  "see details", "see more", "see all", "see the details", "read more", "read on", "read the article", "read the post", "read the blog post", "read article", "read post",
  "read paper", "read the paper", "read full story", "read the full story", "continue reading", "continue", "learn more", "find out more", "discover more", "explore", "explore more",
  "get started", "click here", "here", "more", "more details", "details", "link", "open", "download", "watch", "watch now", "watch video", "listen", "listen now",
  "announcement", "news", "update", "release", "changelog", "blog", "untitled", "home", "overview",
]);

const normalised = (title: string): string => title.toLowerCase().replace(/[\s ]+/g, " ").replace(/[\s.…→»›>:]+$/g, "").trim();

/** Whether a title is only a label: "View details", "Read more", "Learn more →", "Overview". */
export const isVagueTitle = (title: string): boolean => LABELS.has(normalised(title));
