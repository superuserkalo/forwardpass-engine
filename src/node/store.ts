import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ObjectStore } from "../lib/private-store.js";

// Node-only backends for scripts and local runs. Never imported by the Worker.

export function localStore(root = join(process.cwd(), ".delivery")): ObjectStore {
  const path = (key: string) => join(root, key);
  return {
    async get(key) {
      try { return await readFile(path(key), "utf8"); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    },
    async create(key, body) {
      await mkdir(dirname(path(key)), { recursive: true });
      try { await writeFile(path(key), body, { encoding: "utf8", flag: "wx", mode: 0o600 }); return true; }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
    },
    async put(key, body) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), body, { encoding: "utf8", mode: 0o600 });
    },
    async list(prefix) {
      const base = path(prefix);
      try {
        const files = await readdir(base, { recursive: true, withFileTypes: true });
        return files.filter((file) => file.isFile())
          .map((file) => `${prefix}${join(relative(base, file.parentPath), file.name).replaceAll("\\", "/")}`.replace(/\/\.\//g, "/"))
          .sort();
      } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
    },
    async delete(key) { await rm(path(key), { force: true }); },
  };
}

// R2 over its S3 API, for local runs against production data.
export function r2S3Store(): ObjectStore {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = process.env;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2 EU storage is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).");
  const client = new S3Client({ region: "auto", endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
  const status = (error: unknown) => error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
  return {
    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body ? response.Body.transformToString() : null;
      } catch (error) { if (status(error) === 404) return null; throw error; }
    },
    async create(key, body) {
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", IfNoneMatch: "*" })); return true; }
      catch (error) { if (status(error) === 412) return false; throw error; }
    },
    async put(key, body) { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" })); },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

// Reads production data but writes to a scratch directory: dry runs against real inputs.
/** Reads fall through to `read`, writes stay in `write`. Keys under `hidden` prefixes are never read from `read`. */
export function overlayStore(read: ObjectStore, write: ObjectStore, hidden: string[] = []): ObjectStore {
  const visible = (key: string) => !hidden.some((prefix) => key.startsWith(prefix));
  return {
    async get(key) { return (await write.get(key)) ?? (visible(key) ? read.get(key) : null); },
    create: async (key, body) => (!visible(key) || (await read.get(key)) === null) && write.create(key, body),
    put: (key, body) => write.put(key, body),
    async list(prefix) { return [...new Set([...await read.list(prefix), ...await write.list(prefix)])].sort(); },
    delete: (key) => write.delete(key),
  };
}
