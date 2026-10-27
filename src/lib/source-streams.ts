import { CATALOG_ROUTES } from "./source-catalog.generated.js";

export interface SourceStream {
  id: string;
  publisher: string;
  // Stable editorial owner across blogs, changelogs and repository releases.
  publisherId: string;
  section: string;
  category: string;
  kind: "rss" | "atom" | "github-releases" | "html-news" | "json-index" | "markdown" | "hn-list" | "sitemap";
  /** Sitemap streams: a regular expression the article URL path must match. */
  match?: string;
  host?: string;
  access?: "public" | "permission-required" | "reference";
  accessReason?: string;
  intervalHours?: number;
  catalogUrls?: readonly string[];
  notes?: string;
  url: string;
}

// Each entry is an actual publication stream, not a publisher-wide coverage claim.
// Publisher inventory and candidate routes live in sources.ts and docs/source-catalog.json.
const ESTABLISHED_STREAMS: readonly SourceStream[] = [
  { id: "openai-news", publisher: "OpenAI", publisherId: "openai", section: "news", category: "primary announcement", kind: "rss", url: "https://openai.com/news/rss.xml" },
  { id: "anthropic-news", publisher: "Anthropic", publisherId: "anthropic", section: "newsroom", category: "primary announcement", kind: "html-news", url: "https://www.anthropic.com/news" },
  { id: "deepmind-blog", publisher: "Google DeepMind", publisherId: "google", section: "research blog", category: "primary announcement", kind: "rss", url: "https://deepmind.google/blog/rss.xml" },
  { id: "google-deepmind-news", publisher: "Google", publisherId: "google", section: "DeepMind news", category: "primary announcement", kind: "rss", url: "https://blog.google/innovation-and-ai/models-and-research/google-deepmind/rss/" },
  { id: "google-developer-tools", publisher: "Google", publisherId: "google", section: "developer tools news", category: "developer tooling", kind: "rss", url: "https://blog.google/innovation-and-ai/technology/developers-tools/rss/" },
  { id: "huggingface-blog", publisher: "Hugging Face", publisherId: "huggingface", section: "blog", category: "developer tooling", kind: "rss", url: "https://huggingface.co/blog/feed.xml" },
  { id: "langchain-blog", publisher: "LangChain", publisherId: "langchain", section: "blog", category: "developer tooling", kind: "rss", url: "https://www.langchain.com/blog/rss.xml" },
  { id: "github-changelog", publisher: "GitHub", publisherId: "microsoft", section: "changelog", category: "developer tooling", kind: "rss", url: "https://github.blog/changelog/feed/" },
  { id: "vercel-news", publisher: "Vercel", publisherId: "vercel", section: "news and changelog", category: "developer tooling", kind: "atom", url: "https://vercel.com/atom" },
  { id: "cloudflare-agents", publisher: "Cloudflare", publisherId: "cloudflare", section: "Agents changelog", category: "agent infrastructure", kind: "rss", url: "https://developers.cloudflare.com/changelog/rss/agents.xml" },
  { id: "cloudflare-ai-gateway", publisher: "Cloudflare", publisherId: "cloudflare", section: "AI Gateway changelog", category: "inference infrastructure", kind: "rss", url: "https://developers.cloudflare.com/changelog/rss/ai-gateway.xml" },
  { id: "cloudflare-workers-ai", publisher: "Cloudflare", publisherId: "cloudflare", section: "Workers AI changelog", category: "inference infrastructure", kind: "rss", url: "https://developers.cloudflare.com/changelog/rss/workers-ai.xml" },
  { id: "arxiv-cs-ai", publisher: "arXiv", publisherId: "arxiv", section: "cs.AI papers", category: "research", kind: "rss", url: "https://rss.arxiv.org/rss/cs.AI" },
  { id: "github-vercel-ai", publisher: "Vercel", publisherId: "vercel", section: "vercel/ai releases", category: "software release", kind: "github-releases", url: "https://api.github.com/repos/vercel/ai/releases?per_page=100" },
  { id: "github-langchainjs", publisher: "LangChain", publisherId: "langchain", section: "langchain-ai/langchainjs releases", category: "software release", kind: "github-releases", url: "https://api.github.com/repos/langchain-ai/langchainjs/releases?per_page=100" },
  { id: "github-mcp-typescript", publisher: "MCP", publisherId: "modelcontextprotocol", section: "modelcontextprotocol/typescript-sdk releases", category: "software release", kind: "github-releases", url: "https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases?per_page=100" },
];

// Preserve checkpoint IDs and editorial ownership for established streams, while
// registering every audited route. Reference/permission routes remain visible.
const establishedByUrl = new Map(ESTABLISHED_STREAMS.map((stream) => [stream.url, stream]));
export const SOURCE_STREAMS: readonly SourceStream[] = [
  ...CATALOG_ROUTES.map((route): SourceStream => ({ ...route, ...establishedByUrl.get(route.url) })),
  ...ESTABLISHED_STREAMS.filter((stream) => !CATALOG_ROUTES.some((route) => route.url === stream.url)),
];
