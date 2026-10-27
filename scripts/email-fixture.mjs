// A small issue, enough to render every part of the shared email: featured stories with bodies, bullets and a catch, and signal lines.
export const ISSUE = {
  version: 2, date: "2026-10-08", createdAt: "2026-10-08T05:40:00.000Z", subject: "OpenAI ships GPT-6 to every ChatGPT user",
  preview: "GPT-6 reaches everyone, Haiku 5.5 adds adjustable effort, and a memory library for agents.",
  intro: ["Big day for models.", "Two launches and a library.", "Here is what matters."],
  stories: [
    { id: "s-0000000000000000", role: "featured", position: 0, label: "Top News", type: "news", headline: "OpenAI ships **GPT-6** to every ChatGPT user", body: "GPT-6 now reaches all users and answers [44% sooner](https://openai.com/index/gpt-6/).\n\n- It thinks before it replies.\n- It rolls out today.\n\nOne catch: the first models only reached paid customers.\n\nTry it: open ChatGPT.", url: "https://openai.com/index/gpt-6/", sources: [{ label: "OpenAI", url: "https://openai.com/index/gpt-6/" }, { label: "The Verge", url: "https://theverge.com/gpt-6" }], traction: "506 HN points", topics: ["LLMs"], project: null, publishedAt: "2026-10-08T04:00:00.000Z", facts: [] },
    { id: "s-0000000000000001", role: "featured", position: 1, label: "Models", type: "models", headline: "Anthropic releases Haiku 5.5 with adjustable effort", body: "Haiku 5.5 is the first Haiku with an adjustable effort setting.", url: "https://www.anthropic.com/claude-haiku-5-5", sources: [{ label: "Anthropic", url: "https://www.anthropic.com/claude-haiku-5-5" }], traction: null, topics: ["LLMs", "Agents"], project: null, publishedAt: "2026-10-08T03:00:00.000Z", facts: [] },
    { id: "s-0000000000000002", role: "signal", position: 2, label: "Signal", type: "repos", headline: "Acme open-sources an agent memory library", body: null, url: "https://github.com/acme/agent-memory", sources: [{ label: "GitHub", url: "https://github.com/acme/agent-memory" }], traction: "512 GitHub stars", topics: ["Agents"], project: "acme/agent-memory", publishedAt: null, facts: [] },
    { id: "s-0000000000000003", role: "signal", position: 3, label: "Signal", type: "news", headline: "Databricks makes on-behalf-of-user authorization generally available", body: null, url: "https://www.databricks.com/blog/obo", sources: [{ label: "Databricks", url: "https://www.databricks.com/blog/obo" }], traction: null, topics: ["Security"], project: null, publishedAt: null, facts: [] },
  ],
  markdown: "# OpenAI ships GPT-6\n\n" + "word ".repeat(450),
  pipeline: { candidates: 1, clusters: 1, shortlisted: 1, kept: 1, models: {}, usage: [], checks: {} },
};
export const OPTIONS = { firstName: "Ada", unsubscribeUrl: "https://theforwardpass.net/unsubscribe?email=ada%40example.com", preferencesUrl: "https://theforwardpass.net/preferences/open#token=abc.def" };
