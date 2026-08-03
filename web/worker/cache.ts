import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";

export interface ObjectCacheBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: Record<string, unknown>): Promise<unknown>;
}

export class HotPromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly maximumEntries: number) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const pending = loader().catch((error) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    return pending;
  }
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeJson(value: unknown): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(value)), { level: 6 });
}

export function decodeJson<T>(value: ArrayBuffer | Uint8Array): T {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return JSON.parse(strFromU8(gunzipSync(bytes))) as T;
}

export async function readObjectJson<T>(bucket: ObjectCacheBucket | undefined, key: string): Promise<T | null> {
  if (!bucket) return null;
  try {
    const object = await bucket.get(key);
    return object ? decodeJson<T>(await object.arrayBuffer()) : null;
  } catch (error) {
    console.warn("Object cache read failed", { key, error });
    return null;
  }
}

export async function writeObjectJson(bucket: ObjectCacheBucket | undefined, key: string, value: unknown): Promise<boolean> {
  if (!bucket) return false;
  try {
    const body = encodeJson(value);
    await bucket.put(key, body, {
      httpMetadata: { contentType: "application/gzip", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { encoding: "gzip-json", schema: "1" },
    });
    return true;
  } catch (error) {
    console.warn("Object cache write failed", { key, error });
    return false;
  }
}
