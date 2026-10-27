import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadEnvFile } from "node:process";
import { articleFromMarkdown, listArticles, removeArticle, saveArticle } from "../src/lib/articles.ts";
import { ensureArticleImage } from "../src/lib/cover-images.ts";
import { articlePaths, pingIndexNow } from "../src/lib/indexnow.ts";

try {
  loadEnvFile(".env.local");
} catch {
  // Local storage works without secrets.
}

const [command, target] = process.argv.slice(2);
const usage = "Usage: articles <publish path/to/piece.md | list | remove slug>";

if (command === "publish" && target) {
  const article = articleFromMarkdown(readFileSync(target, "utf8"), basename(target, ".md"));
  await saveArticle(article);
  console.log(`Published ${article.kind} "${article.title}" as /archive/editorial/${article.slug} (${article.publishedAt})`);
  // Extras: the article is already published if either fails.
  try {
    console.log(`Image: ${await ensureArticleImage(article.slug)}`);
  } catch (error) {
    console.warn(`Image failed: ${error instanceof Error ? error.message : error}`);
  }
  if (Date.parse(article.publishedAt) <= Date.now()) {
    try {
      console.log(`IndexNow: ${JSON.stringify(await pingIndexNow(articlePaths(article.slug)))}`);
    } catch (error) {
      console.warn(`IndexNow failed: ${error instanceof Error ? error.message : error}`);
    }
  }
} else if (command === "list") {
  for (const article of await listArticles(new Date(8.64e15))) {
    console.log(`${article.publishedAt.slice(0, 10)}  ${article.kind.padEnd(9)}  ${article.slug}  ${article.title}`);
  }
} else if (command === "remove" && target) {
  await removeArticle(target);
  console.log(`Removed ${target}`);
} else {
  throw new Error(usage);
}
