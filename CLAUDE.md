# Sync API
End to end encrypted sync for every Sabin Labs app. The server stores only ciphertext.

## Stack
Cloudflare Worker · SQLite Durable Object per sync space · TypeScript · Vitest · wrangler.

## Commands
- Dev: `npx wrangler dev` · Deploy: `npm run deploy`
- Test: `npm test` · Lint: `npm run typecheck`
- Build check: `npx wrangler deploy --dry-run --outdir dist`

## Architecture
- `src/space.ts` pure request handling (auth, versions, limits) behind a storage interface. Fully tested.
- `src/index.ts` router plus the `SyncSpace` Durable Object.
- `client/sync.ts` the browser client apps copy. Tested end to end against space.ts.

## Data rules
- The server must never see plaintext or the sync secret. Never log a request body or a token.
- Writes use optimistic versioning: a stale write returns 409 and the client merges and retries.
- Limits are deliberate: 256KB per document, 30 writes a minute, CORS only for our own origins.
  Never weaken them without an issue that says so.

## Testing rules
- Every behaviour change needs a test, including the refusal cases (wrong token, stale version, oversize body).
- Run typecheck and tests before finishing.

## Security and git
- Never commit secrets, keystores, .env files or email addresses.
- Keep the Content-Security-Policy strict; add a host to connect-src only when a feature needs it.
- `main` is protected: branch, open a PR, merge when CI is green. One issue per PR, under ~300 lines.

## Done when
Typecheck clean, tests pass, CI green, PR opened with a three line summary.
