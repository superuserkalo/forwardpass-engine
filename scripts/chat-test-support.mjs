import { DatabaseSync } from "node:sqlite";
import { ChatSubscriptions } from "../src/lib/chat-subscriptions.ts";
import { issueV2Schema, storyId } from "../src/lib/issue.ts";

export function chatFixture() {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } },
    transactionSync(operation) {
      db.exec("BEGIN");
      try { const result = operation(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const registry = new ChatSubscriptions(storage);
  const service = Object.fromEntries([
    "createLink", "link", "attach", "list", "slackAccount", "destination", "update", "stop", "audience", "claim", "finish",
    "setIfAbsent", "mutateList", "shift", "extendLock", "releaseLock",
  ].map(name => [name, async (...args) => registry[name](...args)]));
  service.getValue = async key => registry.get(`sdk:${key}`);
  service.setValue = async (key, value, ttl) => registry.set(`sdk:${key}`, value, ttl);
  service.deleteValue = async key => registry.delete(`sdk:${key}`);
  // SDK state keys are isolated from the connection and delivery authority.
  for (const name of ["setIfAbsent", "mutateList", "shift", "extendLock", "releaseLock"]) {
    service[name] = async (key, ...args) => registry[name](`sdk:${key}`, ...args);
  }
  return { registry, service, db };
}

export function candidate(platform = "telegram", suffix = "1", mode = "personal") {
  return { platform, mode, target: `${platform}:${suffix}`, actor: suffix, installation: null, label: `${platform} ${suffix}` };
}
export function activeDestination(registry, value = candidate(), owner = "reader@example.com") {
  const { token } = registry.createLink(owner, value.platform, value.mode);
  if (!registry.attach(token, value)) throw new Error("Fixture attach failed");
  const destination = registry.list(owner).find(item => item.target === value.target);
  if (!registry.update(owner, destination.id, "active")) throw new Error("Fixture confirm failed");
  return registry.destination(destination.id);
}
export function issueFixture() {
  const date = "2026-10-03";
  return issueV2Schema.parse({
    version: 2, date, createdAt: `${date}T05:30:00.000Z`, subject: "Today's edition", preview: "Today's developments",
    intro: ["Three developments to follow.", "A second paragraph.", "A third paragraph."], markdown: "# Today's edition",
    stories: Array.from({ length: 9 }, (_, index) => {
      const url = `https://lab.example.com/story-${index}`;
      return { id: storyId(date, url), role: index < 3 ? "featured" : "signal", position: index, label: "News", type: "news", headline: `Development ${index}`,
        body: index < 3 ? "The verified story." : null, url, sources: [{ label: "Lab", url }], traction: null, topics: [], project: null, publishedAt: null, facts: [] };
    }), pipeline: { candidates: 9, clusters: 9, shortlisted: 9, kept: 9, models: {}, usage: [], checks: {} },
  });
}

export const configured = {
  PREFERENCES_SIGNING_SECRET: "test-only-preferences-secret-with-at-least-32-characters",
  PUBLIC_SITE_URL: "https://theforwardpass.net",
  TELEGRAM_BOT_TOKEN: "100000:test-only-token", TELEGRAM_WEBHOOK_SECRET_TOKEN: "test-only-webhook-secret", TELEGRAM_BOT_USERNAME: "ForwardPassTestBot",
  SLACK_SIGNING_SECRET: "test-only-signing-secret", SLACK_CLIENT_ID: "100.200", SLACK_CLIENT_SECRET: "test-only-client-secret", SLACK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  DISCORD_BOT_TOKEN: "test-only-token", DISCORD_APPLICATION_ID: "100000000000000000", DISCORD_PUBLIC_KEY: "00".repeat(32),
  TEAMS_APP_ID: "11111111-1111-4111-8111-111111111111", TEAMS_APP_PASSWORD: "test-only-password", TEAMS_APP_TENANT_ID: "22222222-2222-4222-8222-222222222222", TEAMS_APP_TYPE: "SingleTenant",
};
