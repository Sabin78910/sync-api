/**
 * Sabin Sync client: copy this file into an app (src/sync.ts). No dependencies; uses WebCrypto.
 *
 * A sync code looks like `SS1-<spaceId>-<secret>`. The secret never leaves the user's devices:
 * it derives an AES-GCM key (encrypts the data) and a separate auth token (proves ownership).
 * The server only ever sees ciphertext.
 */

export const DEFAULT_SYNC_URL = "https://sync-api.sabin-apps.workers.dev";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface ParsedCode {
  spaceId: string;
  secret: Uint8Array;
}

/** Creates a new random sync code for this user. */
export function newSyncCode(): string {
  const space = crypto.getRandomValues(new Uint8Array(16));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return `SS1-${toB64url(space)}-${toB64url(secret)}`;
}

export function parseSyncCode(code: string): ParsedCode | null {
  const m = /^SS1-([A-Za-z0-9_-]{22})-([A-Za-z0-9_-]{43})$/.exec(code.trim());
  if (!m) return null;
  return { spaceId: m[1], secret: fromB64url(m[2]) };
}

export interface Keys {
  authToken: string;
  key: CryptoKey;
}

export async function deriveKeys(secret: Uint8Array): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits", "deriveKey"]);
  const salt = enc.encode("sabin-sync-v1");
  const authBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("auth") }, base, 256);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("encrypt") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const authToken = [...new Uint8Array(authBits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { authToken, key };
}

/** Encrypts a JSON value; the app name is bound as associated data so documents can't be swapped. */
export async function encryptJson(key: CryptoKey, app: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(app) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return toB64url(out);
}

export async function decryptJson<T>(key: CryptoKey, app: string, data: string): Promise<T> {
  const bytes = fromB64url(data);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(app) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(dec.decode(pt)) as T;
}

export type PushResult = { ok: true; version: number } | { ok: false; conflict: true; version: number } | { ok: false; conflict: false; error: string };

export class SyncClient {
  private keys: Promise<Keys>;
  private spaceId: string;

  constructor(
    code: string,
    private app: string,
    private baseUrl = DEFAULT_SYNC_URL,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    const parsed = parseSyncCode(code);
    if (!parsed) throw new Error("Invalid sync code");
    this.spaceId = parsed.spaceId;
    this.keys = deriveKeys(parsed.secret);
  }

  private url(): string {
    return `${this.baseUrl}/v1/spaces/${this.spaceId}/${this.app}`;
  }

  /** Returns the latest synced value, or null when nothing has been synced yet. */
  async pull<T>(): Promise<{ version: number; value: T } | null> {
    const { authToken, key } = await this.keys;
    const res = await this.fetchImpl(this.url(), { headers: { Authorization: `Bearer ${authToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sync pull failed (${res.status})`);
    const doc = (await res.json()) as { version: number; data: string };
    return { version: doc.version, value: await decryptJson<T>(key, this.app, doc.data) };
  }

  /** Uploads a value if the server is still at baseVersion; otherwise reports a conflict to merge. */
  async push(value: unknown, baseVersion: number): Promise<PushResult> {
    const { authToken, key } = await this.keys;
    const data = await encryptJson(key, this.app, value);
    const res = await this.fetchImpl(this.url(), {
      method: "PUT",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ data, baseVersion }),
    });
    const body = (await res.json()) as { version?: number; error?: string };
    if (res.ok) return { ok: true, version: body.version! };
    if (res.status === 409) return { ok: false, conflict: true, version: body.version ?? 0 };
    return { ok: false, conflict: false, error: body.error ?? `HTTP ${res.status}` };
  }

  /**
   * Pull, merge with local, push. Retries once on a conflict.
   * `merge(local, remote)` decides the combined value (for lists, merge by id and keep the newest).
   */
  async sync<T>(local: T, baseVersion: number, merge: (local: T, remote: T) => T): Promise<{ value: T; version: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await this.pull<T>();
      const value = remote ? merge(local, remote.value) : local;
      const res = await this.push(value, remote?.version ?? 0);
      if (res.ok) return { value, version: res.version };
      if (!res.conflict) throw new Error(res.error);
      local = value;
      baseVersion = res.version;
    }
    throw new Error(`Sync kept conflicting (base ${baseVersion}); try again.`);
  }
}
