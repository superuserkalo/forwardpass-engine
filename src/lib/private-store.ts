// Every durable object the engine writes goes through one small store interface.
// The Worker binds R2 directly; Node scripts use the local disk or R2 over S3
// (src/node/store.ts). Keys are validated here so every backend accepts the same set.

export interface ObjectStore {
  get(key: string): Promise<string | null>;
  /** Writes only when the key does not exist yet. Returns false when it already existed. */
  create(key: string, body: string): Promise<boolean>;
  put(key: string, body: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

let active: ObjectStore | null = null;

export function useStore(store: ObjectStore): void {
  active = store;
}

function store(): ObjectStore {
  if (!active) throw new Error("No object store is configured; call useStore() first.");
  return active;
}

export function assertKey(key: string): void {
  if (!/^[a-z0-9/_.-]+\.json$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error(`Invalid private object key: ${key}`);
}

function assertPrefix(prefix: string): void {
  if (!/^[a-z0-9/_.-]+\/$/.test(prefix) || prefix.includes("..") || prefix.startsWith("/")) throw new Error(`Invalid private object prefix: ${prefix}`);
}

export async function readPrivateJson(key: string): Promise<unknown | null> {
  assertKey(key);
  const text = await store().get(key);
  return text === null ? null : JSON.parse(text);
}

/** Create-only write. Immutable artifacts (issues, snapshots, ledger markers) use this. */
export async function createPrivateJson(key: string, value: unknown): Promise<boolean> {
  assertKey(key);
  return store().create(key, JSON.stringify(value));
}

export async function listPrivateJsonKeys(prefix: string): Promise<string[]> {
  assertPrefix(prefix);
  return (await store().list(prefix)).filter((key) => key.endsWith(".json"));
}

/** Overwrites an object. Use only for mutable state (collector state, votes), never for published editions. */
export async function writePrivateJson(key: string, value: unknown): Promise<void> {
  assertKey(key);
  await store().put(key, JSON.stringify(value));
}

export async function deletePrivateJson(key: string): Promise<void> {
  assertKey(key);
  await store().delete(key);
}

/** In-memory store for tests. */
export function memoryStore(initial: Record<string, unknown> = {}): ObjectStore & { objects: Map<string, string> } {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    objects,
    async get(key) { return objects.get(key) ?? null; },
    async create(key, body) { if (objects.has(key)) return false; objects.set(key, body); return true; },
    async put(key, body) { objects.set(key, body); },
    async list(prefix) { return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(); },
    async delete(key) { objects.delete(key); },
  };
}
