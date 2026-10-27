import type { ObjectStore } from "./private-store.js";

// R2 through the Worker binding: no credentials in the Worker, and create-only writes
// use R2's own precondition so two concurrent writers cannot both succeed.
export function r2BindingStore(bucket: R2Bucket): ObjectStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object ? object.text() : null;
    },
    async create(key, body) {
      const written = await bucket.put(key, body, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      return written !== null;
    },
    async put(key, body) {
      await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        keys.push(...page.objects.map(({ key }) => key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
