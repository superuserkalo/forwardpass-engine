// Merges reposts of one release (platform availability, day-0 support, roundups,
// "announcing" variants) into a single story before ranking, so they stop taking
// several places. Separate events about the same model — evaluations, benchmarks,
// customer stories, questions — stay separate.

// A model identity is a name bound to a version: "GPT-6", "Opus 5.5", "Gemini 3.8", "Kimi-K3", "FLUX 3".
// A trailing "%", "-" or "." means a quantity or range ("prices 40-50%"), not a version.
const VERSIONED = /\b([a-z][a-z]+)[- ]?(k?\d+(?:\.\d+)*)(?![\w.%-])/gi;
// Words that often precede a number without naming a model.
const NOT_MODELS = new Set(["top", "the", "and", "for", "with", "from", "day", "part", "step", "phase", "version", "chapter", "series", "week", "year", "over", "under", "about", "only", "just", "than", "into", "gets", "hits", "beats", "cuts", "runs", "costs", "scores"]);
const FOLLOWER = /\[ainews\]|\b(introduc\w*|announc\w*|now (?:generally )?available|generally available|comes? to|coming to|arriv\w*|lands? (?:in|on)|day[- ](?:0|zero|one)|support (?:for|of)|launch\w*|releas\w*|ships?|rolls? out|new default model)\b|\b(?:in|on|to|via) (?:amazon bedrock|bedrock|aws|azure|microsoft foundry|foundry|vertex(?: ai)?|lovable|cursor|github copilot|openrouter|databricks|snowflake)\b/i;
const VARIANT_STOP = new Set(["and", "the", "for", "with", "now", "new", "api", "model", "models", "comes", "is", "are", "in", "on", "to", "of", "a", "an"]);

export type ReleaseTitle = { versions: Set<string>; variants: Set<string>; follower: boolean };

export function releaseTitle(title: string): ReleaseTitle {
  const versions = new Set<string>();
  const variants = new Set<string>();
  for (const match of title.matchAll(VERSIONED)) {
    const name = match[1].toLowerCase();
    if (NOT_MODELS.has(name) || /^\d+$/.test(match[2]) && Number(match[2]) >= 1900) continue;
    versions.add(`${name}-${match[2].toLowerCase()}`);
    // Capitalised words right after the version name the family members ("Sol and Luna", "Action").
    const rest = title.slice((match.index ?? 0) + match[0].length).split(/[:;,.!?()\[\]—–|]/)[0];
    for (const word of rest.match(/\b[A-Z][\w-]*\b/g) ?? []) {
      if (!VARIANT_STOP.has(word.toLowerCase()) && !/\d/.test(word)) variants.add(word.toLowerCase());
    }
  }
  return { versions, variants, follower: FOLLOWER.test(title) };
}

// `candidate` repeats `anchor`'s release when it names the same model version and is itself
// a release/availability post, or names the same family member. Only the candidate's wording
// counts: a launch anchor ("Introducing X") must not absorb every later story about X.
export function sameRelease(anchor: ReleaseTitle, candidate: ReleaseTitle): boolean {
  if (![...anchor.versions].some((version) => candidate.versions.has(version))) return false;
  return candidate.follower || [...anchor.variants].some((variant) => candidate.variants.has(variant));
}

// Folds each cluster into the first earlier cluster reporting the same release.
// Callers pass clusters in priority order; the surviving cluster keeps its position.
export function mergeSameRelease<T extends { items: { title: string }[] }>(clusters: readonly T[]): T[] {
  const kept: { cluster: T; titles: ReleaseTitle[] }[] = [];
  for (const cluster of clusters) {
    const titles = cluster.items.map(({ title }) => releaseTitle(title)).filter(({ versions }) => versions.size);
    const target = titles.length ? kept.find((entry) => entry.titles.some((a) => titles.some((b) => sameRelease(a, b)))) : undefined;
    // Absorbed titles are not added to the match set: a repost naming "Astra" must not
    // let a later Astra customer story chain into the Sol/Luna launch.
    if (target) target.cluster.items.push(...cluster.items);
    else kept.push({ cluster, titles });
  }
  return kept.map(({ cluster }) => cluster);
}
