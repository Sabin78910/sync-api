import {
  corsOrigin,
  handleDelete,
  handleGet,
  handlePut,
  isExpired,
  isValidApp,
  isValidSpaceId,
  MAX_BYTES,
  safeEqual,
  sha256Hex,
  WRITES_PER_MINUTE,
  type Doc,
  type SpaceStorage,
} from "./space";
import {
  decryptJson,
  deriveKeys,
  encryptJson,
  fromB64url,
  newSyncCode,
  parseSyncCode,
  SyncClient,
  toB64url,
} from "../client/sync";

function memStore(): SpaceStorage & { docs: Map<string, Doc>; meta: Map<string, string> } {
  const docs = new Map<string, Doc>();
  const meta = new Map<string, string>();
  return {
    docs,
    meta,
    getMeta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    getDoc: (a) => docs.get(a) ?? null,
    putDoc: (a, d) => void docs.set(a, d),
    wipe: () => {
      docs.clear();
      meta.clear();
    },
  };
}

const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A fake fetch that routes to the real handlers, so the client is tested end to end. */
function fakeServer() {
  const spaces = new Map<string, ReturnType<typeof memStore>>();
  let now = 1_000_000;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, , , spaceId, app] = url.pathname.split("/");
    if (!spaces.has(spaceId)) spaces.set(spaceId, memStore());
    const store = spaces.get(spaceId)!;
    const token = (init?.headers as Record<string, string>)?.Authorization?.replace("Bearer ", "") ?? null;
    const r =
      init?.method === "PUT"
        ? await handlePut(store, app, token, JSON.parse(String(init.body)), (now += 1000))
        : await handleGet(store, app, token);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchImpl, spaces };
}

describe("validation", () => {
  it("accepts well-formed ids and app names", () => {
    expect(isValidSpaceId("A".repeat(22))).toBe(true);
    expect(isValidSpaceId("short")).toBe(false);
    expect(isValidSpaceId("A".repeat(21) + "/")).toBe(false);
    expect(isValidApp("todo-web")).toBe(true);
    expect(isValidApp("Todo")).toBe(false);
    expect(isValidApp("x")).toBe(false);
  });
  it("allows only the app origins for CORS", () => {
    expect(corsOrigin("https://sabin78910.github.io")).toBe("https://sabin78910.github.io");
    expect(corsOrigin("capacitor://localhost")).toBe("capacitor://localhost");
    expect(corsOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(corsOrigin("https://evil.example")).toBeNull();
    expect(corsOrigin("https://sabin78910.github.io.evil.example")).toBeNull();
    expect(corsOrigin(null)).toBeNull();
  });
  it("compares digests safely", async () => {
    const h = await sha256Hex("x");
    expect(h).toHaveLength(64);
    expect(safeEqual(h, h)).toBe(true);
    expect(safeEqual(h, h.replace(/.$/, "0"))).toBe(h.endsWith("0"));
    expect(safeEqual("ab", "abc")).toBe(false);
  });
});

describe("space handlers", () => {
  it("returns 404 for an empty space and 401 without a token", async () => {
    const s = memStore();
    expect((await handleGet(s, "todo", TOKEN)).status).toBe(404);
    expect((await handleGet(s, "todo", null)).status).toBe(401);
    expect((await handleGet(s, "todo", "nothex")).status).toBe(401);
  });
  it("first write claims the space; another token is refused", async () => {
    const s = memStore();
    expect((await handlePut(s, "todo", TOKEN, { data: "abc", baseVersion: 0 }, 1)).status).toBe(200);
    expect(s.meta.get("auth")).toBe(await sha256Hex(TOKEN)); // stores a hash, not the token
    expect((await handleGet(s, "todo", OTHER)).status).toBe(403);
    expect((await handlePut(s, "todo", OTHER, { data: "x", baseVersion: 1 }, 2)).status).toBe(403);
    const got = await handleGet(s, "todo", TOKEN);
    expect(got.status).toBe(200);
    expect(got.body.version).toBe(1);
  });
  it("rejects stale writes with 409 and the current version", async () => {
    const s = memStore();
    await handlePut(s, "todo", TOKEN, { data: "v1", baseVersion: 0 }, 1);
    await handlePut(s, "todo", TOKEN, { data: "v2", baseVersion: 1 }, 2);
    const stale = await handlePut(s, "todo", TOKEN, { data: "old", baseVersion: 1 }, 3);
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(2);
    expect(s.docs.get("todo")!.data).toBe("v2");
  });
  it("validates the body and size", async () => {
    const s = memStore();
    expect((await handlePut(s, "a1", TOKEN, null, 1)).status).toBe(400);
    expect((await handlePut(s, "a1", TOKEN, { data: "has spaces", baseVersion: 0 }, 1)).status).toBe(400);
    expect((await handlePut(s, "a1", TOKEN, { data: "ok", baseVersion: -1 }, 1)).status).toBe(400);
    expect((await handlePut(s, "a1", TOKEN, { data: "x".repeat(MAX_BYTES + 1), baseVersion: 0 }, 1)).status).toBe(413);
    expect(s.meta.get("auth")).toBeUndefined(); // invalid requests never claim the space
  });
  it("keeps apps separate inside one space", async () => {
    const s = memStore();
    await handlePut(s, "todo", TOKEN, { data: "t", baseVersion: 0 }, 1);
    await handlePut(s, "loans", TOKEN, { data: "l", baseVersion: 0 }, 2);
    expect((await handleGet(s, "todo", TOKEN)).body.data).toBe("t");
    expect((await handleGet(s, "loans", TOKEN)).body.data).toBe("l");
  });
  it("rate-limits bursts of writes", async () => {
    const s = memStore();
    let last = 0;
    for (let i = 0; i < WRITES_PER_MINUTE + 1; i++) {
      last = (await handlePut(s, "todo", TOKEN, { data: "d", baseVersion: i }, 1000 + i)).status;
    }
    expect(last).toBe(429);
    expect((await handlePut(s, "todo", TOKEN, { data: "d", baseVersion: WRITES_PER_MINUTE }, 70_000)).status).toBe(200);
  });
  it("delete wipes everything, only for the owner", async () => {
    const s = memStore();
    await handlePut(s, "todo", TOKEN, { data: "t", baseVersion: 0 }, 1);
    expect((await handleDelete(s, OTHER)).status).toBe(403);
    expect((await handleDelete(s, TOKEN)).status).toBe(200);
    expect(s.docs.size).toBe(0);
    expect((await handleGet(s, "todo", TOKEN)).status).toBe(404);
  });
  it("expires spaces idle for over a year", async () => {
    const s = memStore();
    expect(isExpired(s, Date.now())).toBe(false);
    s.setMeta("lastWrite", "0");
    expect(isExpired(s, Date.now())).toBe(false);
    s.setMeta("lastWrite", String(1));
    expect(isExpired(s, 1 + 366 * 86_400_000)).toBe(true);
    expect(isExpired(s, 1 + 300 * 86_400_000)).toBe(false);
  });
});

describe("client crypto", () => {
  it("round-trips base64url", () => {
    const b = crypto.getRandomValues(new Uint8Array(50));
    expect(fromB64url(toB64url(b))).toEqual(b);
  });
  it("makes and parses sync codes", () => {
    const code = newSyncCode();
    expect(code).toMatch(/^SS1-/);
    const p = parseSyncCode(code)!;
    expect(p.spaceId).toHaveLength(22);
    expect(p.secret).toHaveLength(32);
    expect(parseSyncCode("nonsense")).toBeNull();
    expect(newSyncCode()).not.toBe(code);
  });
  it("derives a stable auth token that is not the secret", async () => {
    const p = parseSyncCode(newSyncCode())!;
    const a = await deriveKeys(p.secret);
    const b = await deriveKeys(p.secret);
    expect(a.authToken).toBe(b.authToken);
    expect(a.authToken).toMatch(/^[a-f0-9]{64}$/);
    expect(a.authToken).not.toContain(toB64url(p.secret));
  });
  it("encrypts so only the right key and app can decrypt", async () => {
    const k1 = (await deriveKeys(parseSyncCode(newSyncCode())!.secret)).key;
    const k2 = (await deriveKeys(parseSyncCode(newSyncCode())!.secret)).key;
    const ct = await encryptJson(k1, "todo", { items: ["milk"] });
    expect(ct).not.toContain("milk");
    expect(await decryptJson(k1, "todo", ct)).toEqual({ items: ["milk"] });
    await expect(decryptJson(k2, "todo", ct)).rejects.toBeTruthy();
    await expect(decryptJson(k1, "notes", ct)).rejects.toBeTruthy();
  });
  it("uses a fresh IV each time", async () => {
    const k = (await deriveKeys(parseSyncCode(newSyncCode())!.secret)).key;
    expect(await encryptJson(k, "a1", 1)).not.toBe(await encryptJson(k, "a1", 1));
  });
});

describe("SyncClient end to end", () => {
  it("two devices with the same code see the same data", async () => {
    const { fetchImpl, spaces } = fakeServer();
    const code = newSyncCode();
    const phone = new SyncClient(code, "todo-web", "https://x", fetchImpl);
    const laptop = new SyncClient(code, "todo-web", "https://x", fetchImpl);
    expect(await phone.pull()).toBeNull();
    expect(await phone.push({ todos: ["a"] }, 0)).toEqual({ ok: true, version: 1 });
    expect(await laptop.pull()).toEqual({ version: 1, value: { todos: ["a"] } });
    // the server never stores plaintext
    const stored = [...spaces.values()][0].docs.get("todo-web")!.data;
    expect(stored).not.toContain("todos");
  });
  it("detects conflicts and merges with sync()", async () => {
    const { fetchImpl } = fakeServer();
    const code = newSyncCode();
    const a = new SyncClient(code, "todo-web", "https://x", fetchImpl);
    const b = new SyncClient(code, "todo-web", "https://x", fetchImpl);
    await a.push(["x"], 0);
    const stale = await b.push(["y"], 0);
    expect(stale).toEqual({ ok: false, conflict: true, version: 1 });
    const merged = await b.sync<string[]>(["y"], 0, (local, remote) => [...new Set([...remote, ...local])]);
    expect(merged.value).toEqual(["x", "y"]);
    expect((await a.pull<string[]>())!.value).toEqual(["x", "y"]);
  });
  it("a different code cannot read or overwrite the space", async () => {
    const { fetchImpl } = fakeServer();
    const code = newSyncCode();
    const owner = new SyncClient(code, "todo-web", "https://x", fetchImpl);
    await owner.push({ secret: 1 }, 0);
    // same space id, different secret
    const forged = `${code.slice(0, 27)}${newSyncCode().slice(27)}`;
    const intruder = new SyncClient(forged, "todo-web", "https://x", fetchImpl);
    await expect(intruder.pull()).rejects.toThrow(/403/);
    const res = await intruder.push({ hacked: true }, 1);
    expect(res.ok).toBe(false);
  });
  it("rejects malformed codes", () => {
    expect(() => new SyncClient("bad", "todo-web")).toThrow();
  });
});
