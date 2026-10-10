# Sync API
Purpose: end-to-end encrypted sync backend for Sabin's web apps (Cloudflare Worker + SQLite Durable Object per space).

## Commands
- Test: `npm test`
- Lint: `npm run typecheck`
- Build: `npx wrangler deploy --dry-run --outdir dist`

## Architecture
- src/space.ts: pure request handling (auth, versions, limits) with a storage interface. Fully tested.
- src/index.ts: Worker router + `SyncSpace` Durable Object (SQLite) wrapping space.ts.
- client/sync.ts: browser client that apps copy (WebCrypto AES-GCM, HKDF). Tested end to end against space.ts.

## Rules
- The server must never see plaintext or the sync secret. Never log request bodies or tokens.
- Every behavior change needs a test. Run tests and typecheck before finishing.
- Never weaken CORS, auth, size or rate limits without an issue that says so.
- Never commit secrets, .dev.vars or .env files, or email addresses.
- Keep PRs under ~300 changed lines; one issue per PR.

## Definition of done
Typecheck clean, tests pass, CI green, short summary, PR opened as draft.
