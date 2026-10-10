import { DurableObject } from "cloudflare:workers";
import {
  corsOrigin,
  handleDelete,
  handleGet,
  handlePut,
  isExpired,
  isValidApp,
  isValidSpaceId,
  IDLE_DAYS,
  type Doc,
  type Reply,
  type SpaceStorage,
} from "./space";

interface Env {
  SPACES: DurableObjectNamespace<SyncSpace>;
}

const SECURITY_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(r: Reply, origin: string | null): Response {
  const headers: Record<string, string> = { ...SECURITY_HEADERS };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}

/** One sync space: SQLite tables for metadata and one encrypted document per app. */
export class SyncSpace extends DurableObject<Env> {
  private store: SpaceStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS docs (app TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)");
    this.store = {
      getMeta: (k) => (sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as string | undefined) ?? null,
      setMeta: (k, v) => void sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v),
      getDoc: (app) => (sql.exec("SELECT version, data, updated FROM docs WHERE app = ?", app).toArray()[0] as unknown as Doc | undefined) ?? null,
      putDoc: (app, d) =>
        void sql.exec(
          "INSERT INTO docs (app, version, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(app) DO UPDATE SET version = excluded.version, data = excluded.data, updated = excluded.updated",
          app,
          d.version,
          d.data,
          d.updated,
        ),
      wipe: () => {
        sql.exec("DELETE FROM docs");
        sql.exec("DELETE FROM meta");
      },
    };
  }

  async get(app: string, token: string | null): Promise<Reply> {
    return handleGet(this.store, app, token);
  }

  async put(app: string, token: string | null, body: unknown): Promise<Reply> {
    const res = await handlePut(this.store, app, token, body, Date.now());
    if (res.status === 200) await this.ctx.storage.setAlarm(Date.now() + (IDLE_DAYS + 1) * 86_400_000);
    return res;
  }

  async remove(token: string | null): Promise<Reply> {
    const res = await handleDelete(this.store, token);
    if (res.status === 200) await this.ctx.storage.deleteAll();
    return res;
  }

  /** Deletes spaces nobody has written to for a year. */
  async alarm(): Promise<void> {
    if (isExpired(this.store, Date.now())) await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = corsOrigin(req.headers.get("Origin"));
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: origin ? 204 : 403,
        headers: origin
          ? {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Authorization, Content-Type",
              "Access-Control-Max-Age": "86400",
              Vary: "Origin",
            }
          : {},
      });
    }
    if (url.pathname === "/v1/health") return json({ status: 200, body: { ok: true, service: "sync-api", e2e: true } }, origin);

    const m = /^\/v1\/spaces\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m || !isValidSpaceId(m[1]) || (m[2] !== undefined && !isValidApp(m[2]))) {
      return json({ status: 404, body: { error: "Not found. See /v1/health." } }, origin);
    }
    const [, spaceId, app] = m;
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const space = env.SPACES.get(env.SPACES.idFromName(spaceId));

    if (app && req.method === "GET") return json(await space.get(app, token), origin);
    if (app && req.method === "PUT") {
      const len = Number(req.headers.get("Content-Length") ?? 0);
      if (len > 300 * 1024) return json({ status: 413, body: { error: "Request too large." } }, origin);
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        return json({ status: 400, body: { error: "Body must be JSON." } }, origin);
      }
      return json(await space.put(app, token, body), origin);
    }
    if (!app && req.method === "DELETE") return json(await space.remove(token), origin);
    return json({ status: 405, body: { error: "Method not allowed." } }, origin);
  },
} satisfies ExportedHandler<Env>;
