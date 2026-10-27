import { GITHUB_ORGS, HF_ORGS } from "../lib/discovery-streams.js";
import type { Candidate } from "../lib/schemas.js";

// Publishers whose own announcements an AI engineer expects to see considered every day: the
// frontier and open-weight labs, cloud and chip vendors, AI developer tools and infrastructure,
// and the independent evaluators. A first-party item from one of them always reaches triage;
// everything else competes for the shortlist on attention. The old lab pattern ended every host
// in a fixed top-level domain list, so blog.google, claude.com, github.blog, runway.com and
// zed.dev never matched and their posts were ranked out behind Hacker News threads.
//
// A host matches itself and any subdomain. A rule with a path narrows a shared host.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Hugging Face hosts anyone's writing: its own posts are /blog/<slug>, a lab's organisation posts /blog/<org>/<slug> and keeps
// its repositories at /<org>/, and a community member's articles are /blog/<user>/<slug>, which are not the publisher's words.
const HF_OWN_PAGES = new RegExp(`^/(?:blog/?$|blog/[^/]+/?$|blog/(?:${HF_ORGS.map(escaped).join("|")})/|(?:${HF_ORGS.map(escaped).join("|")})/)`, "i");
type Rule = string | { host: string; path: RegExp };

const RULES: readonly Rule[] = [
  // Frontier and open-weight model labs
  "openai.com", "anthropic.com", "claude.com", "deepmind.google", "blog.google", "research.google", "ai.google.dev", "developers.googleblog.com", "googleblog.com", "labs.google",
  "ai.meta.com", "about.fb.com", "engineering.fb.com", "llama.com", "mistral.ai", "x.ai", "deepseek.com", "qwen.ai", "qwenlm.github.io", "moonshot.ai", "z.ai", "minimax.io",
  "seed.bytedance.com", "hy.tencent.com", "ernie.baidu.com", "mimo.xiaomi.com", "stepfun.com", "01.ai", "ai21.com", "cohere.com", "reka.ai", "upstage.ai", "liquid.ai",
  "nousresearch.com", "allenai.org", "thinkingmachines.ai", "inceptionlabs.ai", "sakana.ai", "poolside.ai", "magic.dev", "reflection.ai", "ssi.inc", "perplexity.ai", "stability.ai",
  // Big tech and chips
  "nvidia.com", "devblogs.microsoft.com", "blogs.microsoft.com", "news.microsoft.com", "azure.microsoft.com", { host: "microsoft.com", path: /^\/(en-us\/)?(research|ai)\b/ },
  "machinelearning.apple.com", "amazon.science", { host: "aws.amazon.com", path: /^\/(blogs\/(machine-learning|aws|startups|opensource)|bedrock|new)\b/ },
  { host: "cloud.google.com", path: /^\/blog\// },
  "research.ibm.com", "intel.com", "amd.com", "qualcomm.com", "newsroom.arm.com", { host: "huggingface.co", path: HF_OWN_PAGES },
  // AI developer tools, inference and infrastructure
  "cursor.com", "github.blog", "vercel.com", "cloudflare.com", "langchain.com", "llamaindex.ai", "together.ai", "fireworks.ai", "groq.com", "cerebras.ai", "sambanova.ai",
  "baseten.co", "modal.com", "replicate.com", "openrouter.ai", "lightning.ai", "runpod.io", "nebius.com", "lambda.ai", "coreweave.com", "crusoe.ai", "hyperbolic.ai", "novita.ai",
  "replit.com", "lovable.dev", "bolt.new", "windsurf.com", "cognition.com", "cognition.ai", "devin.ai", "factory.ai", "factory.com", "warp.dev", "zed.dev", "jetbrains.com",
  "sourcegraph.com", "ampcode.com", "opencode.ai", "cline.bot", "kilo.ai", "kiro.dev", "augmentcode.com", "vllm.ai", "ollama.com", "lmstudio.ai", "unsloth.ai", "pytorch.org",
  "tensorflow.org", "databricks.com", "snowflake.com", "pinecone.io", "weaviate.io", "qdrant.tech", "trychroma.com", "turbopuffer.com", "mastra.ai", "crewai.com", "e2b.dev",
  "browserbase.com", "firecrawl.dev", "exa.ai", "tavily.com", "jina.ai", "voyageai.com", "mixedbread.com", "langfuse.com", "braintrust.dev", "arize.com", "helicone.ai",
  "modelcontextprotocol.io", "n8n.io",
  // Media and creative models
  "runway.com", "elevenlabs.io", "suno.com", "midjourney.com", "ideogram.ai", "lumalabs.ai", "pika.art", "krea.ai", "bfl.ai", "higgsfield.ai", "fal.ai",
  // Independent evaluators and research institutes
  "artificialanalysis.ai", "epoch.ai", "arcprize.org", "metr.org", "lmarena.ai", "arena.ai", "swebench.com", "vals.ai", "scale.com", "mlcommons.org", "hai.stanford.edu",
  "crfm.stanford.edu", "bair.berkeley.edu",
  // Robotics
  "figure.ai", "bostondynamics.com", "agilityrobotics.com", "apptronik.com", "physicalintelligence.company", "pi.website", "skild.ai", "1x.tech", "unitree.com", "worldlabs.ai", "tri.global",
];

// Forums and help centers on a publisher's domain are not its announcements.
// A community, support or status page is no announcement, however deep: eu.community.openai.com is as much a forum as community.openai.com.
const NOT_ANNOUNCEMENT_LABELS = new Set(["community", "forum", "forums", "discuss", "discourse", "support", "status", "help", "answers", "feedback"]);

// A lab's own repositories: the repository page of a tier-1 GitHub organization (never its issues, releases or a stranger's repo).
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const githubOrgRepos: Rule = { host: "github.com", path: new RegExp(`^/(?:${GITHUB_ORGS.map(escapeRe).join("|")})/[^/]+/?$`, "i") };

const wholeHosts = new Set<string>();
const byHost = new Map<string, RegExp>();
for (const rule of [...RULES, githubOrgRepos]) {
  if (typeof rule === "string") wholeHosts.add(rule);
  else byHost.set(rule.host, rule.path);
}

/** Whether a URL belongs to a tier-1 publisher. */
export function isTier1(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host.split(".").some((label) => NOT_ANNOUNCEMENT_LABELS.has(label))) return false;
  // A path rule reads the path as the server routes it, and an encoded slash or backslash is one segment to a pattern and a
  // separator to the server (a community article at /blog/<user>%2F<slug> would pass for an official post), so none applies to it.
  const routable = !/%(?:2f|5c)/i.test(parsed.pathname);
  // Walk up the labels: blog.cloudflare.com, then cloudflare.com.
  for (let at = host; at.includes("."); at = at.slice(at.indexOf(".") + 1)) {
    if (wholeHosts.has(at)) return true;
    if (routable && byHost.get(at)?.test(parsed.pathname)) return true;
  }
  return false;
}

// Routine package and tag releases are noise wherever they come from.
export const NOISE = /(pypi\.org|vercel\.com\/changelog|\/releases\/tag\/v?\d+\.\d+\.\d+(-|rc|post|dev)|\/releases\/tag\/(?:trunk|nightly|ciflow)|\/releases\/tag\/[^/]*%2F)/i;

// What a publisher's own routes produce. Community submissions, leaderboards and directories do not count.
export const FIRST_PARTY_CATEGORIES = new Set(["news", "primary announcement", "developer tooling", "releases", "changelog", "research", "engineering", "model release", "new repository"]);

/** The publisher's own announcement, release note or write-up, from a tier-1 publisher. */
export function isTier1FirstParty(item: Pick<Candidate, "url" | "source" | "category">): boolean {
  return item.source !== "Hacker News" && FIRST_PARTY_CATEGORIES.has(item.category) && !NOISE.test(item.url) && isTier1(item.url);
}

/** How many tier-1 first-party clusters may join the shortlist beyond the top-ranked ones. */
export const TIER1_SLOTS = 150;
