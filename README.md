# Sync API

End-to-end encrypted sync for the web apps (Todo, Loan Calculator, Weather favourites and more), so the same data
appears on a phone and a laptop **without an account or password**.

![CI](https://github.com/Sabin78910/sync-api/actions/workflows/ci.yml/badge.svg)

**Live:** https://sync-api.sabin-apps.workers.dev/v1/health

## How it works
1. The app creates a sync code on the device: `SS1-<space id>-<secret>`. The user copies or scans it on a second device.
2. HKDF turns the secret into two keys: an **AES-256-GCM key** (encrypts the data on the device) and an **auth token**
   (proves the device may read or write the space). The secret itself is never sent.
3. The server (a Cloudflare Worker with one SQLite Durable Object per space) stores only ciphertext, a version number
   and a hash of the auth token. It can't read anyone's data.
4. Writes use optimistic versioning: a stale write gets `409`, and the client pulls, merges and retries.

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Liveness |
| `GET /v1/spaces/:space/:app` | Encrypted document + version (Bearer auth token) |
| `PUT /v1/spaces/:space/:app` | `{data, baseVersion}`; first write claims the space |
| `DELETE /v1/spaces/:space` | Erase everything in the space |

Limits: 256 KB per app document, 30 writes per minute per space, CORS only for the apps' origins.
Spaces nobody writes to for a year are deleted automatically.

## Use it in an app
Copy `client/sync.ts` into the app, then:
```ts
const code = localStorage.getItem("syncCode") ?? newSyncCode();
const sync = new SyncClient(code, "todo-web");
const { value, version } = await sync.sync(localTodos, lastVersion, mergeById);
```

## Develop
```bash
npm ci
npm test
npx wrangler dev
```
