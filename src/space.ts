/** Request handling for one sync space, independent of storage so it can be unit-tested. */

export const MAX_BYTES = 256 * 1024; // per app document (ciphertext, base64url)
export const WRITES_PER_MINUTE = 30;
export const IDLE_DAYS = 365;

export interface Doc {
  version: number;
  data: string;
  updated: number;
}

export interface SpaceStorage {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  getDoc(app: string): Doc | null;
  putDoc(app: string, doc: Doc): void;
  wipe(): void;
}

export const isValidSpaceId = (id: string) => /^[A-Za-z0-9_-]{22}$/.test(id);
export const isValidApp = (app: string) => /^[a-z0-9-]{2,32}$/.test(app);

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for equal-length hex digests. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });

/** Sliding one-minute write budget, kept in meta so it survives restarts. */
function allowWrite(store: SpaceStorage, now: number): boolean {
  const raw = store.getMeta("writes");
  const recent = (raw ? (JSON.parse(raw) as number[]) : []).filter((t) => now - t < 60_000);
  if (recent.length >= WRITES_PER_MINUTE) return false;
  recent.push(now);
  store.setMeta("writes", JSON.stringify(recent));
  return true;
}

/** Checks the bearer token. The first successful write claims an empty space for that token. */
async function authorise(store: SpaceStorage, token: string | null, claim: boolean): Promise<Reply | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return reply(401, { error: "Missing or malformed sync token." });
  const hash = await sha256Hex(token);
  const owner = store.getMeta("auth");
  if (!owner) {
    if (!claim) return reply(404, { error: "This sync space is empty." });
    store.setMeta("auth", hash);
    return null;
  }
  return safeEqual(owner, hash) ? null : reply(403, { error: "This sync code does not match the space." });
}

export async function handleGet(store: SpaceStorage, app: string, token: string | null): Promise<Reply> {
  const denied = await authorise(store, token, false);
  if (denied) return denied;
  const doc = store.getDoc(app);
  return doc ? reply(200, { ...doc }) : reply(404, { error: "Nothing synced for this app yet." });
}

export async function handlePut(
  store: SpaceStorage,
  app: string,
  token: string | null,
  body: unknown,
  now: number,
): Promise<Reply> {
  const b = body as { data?: unknown; baseVersion?: unknown } | null;
  if (!b || typeof b.data !== "string" || !/^[A-Za-z0-9_-]+$/.test(b.data)) {
    return reply(400, { error: "Body must be {data: base64url ciphertext, baseVersion: number}." });
  }
  if (b.data.length > MAX_BYTES) return reply(413, { error: `Document is larger than ${MAX_BYTES} bytes.` });
  if (typeof b.baseVersion !== "number" || !Number.isInteger(b.baseVersion) || b.baseVersion < 0) {
    return reply(400, { error: "baseVersion must be a non-negative integer (0 for a new document)." });
  }
  const denied = await authorise(store, token, true);
  if (denied) return denied;
  if (!allowWrite(store, now)) return reply(429, { error: "Too many writes. Try again in a minute." });
  const current = store.getDoc(app);
  const currentVersion = current?.version ?? 0;
  if (b.baseVersion !== currentVersion) {
    return reply(409, { error: "Newer data exists. Pull, merge and retry.", version: currentVersion });
  }
  const doc: Doc = { version: currentVersion + 1, data: b.data, updated: now };
  store.putDoc(app, doc);
  store.setMeta("lastWrite", String(now));
  return reply(200, { version: doc.version, updated: now });
}

export async function handleDelete(store: SpaceStorage, token: string | null): Promise<Reply> {
  const denied = await authorise(store, token, false);
  if (denied) return denied;
  store.wipe();
  return reply(200, { deleted: true });
}

/** True when the space has been idle long enough to delete. */
export function isExpired(store: SpaceStorage, now: number): boolean {
  const last = Number(store.getMeta("lastWrite") ?? 0);
  return last > 0 && now - last > IDLE_DAYS * 86_400_000;
}

const ALLOWED_ORIGINS = [/^https:\/\/sabin78910\.github\.io$/, /^capacitor:\/\/localhost$/, /^https?:\/\/localhost(:\d+)?$/];

export function corsOrigin(origin: string | null): string | null {
  return origin && ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : null;
}
