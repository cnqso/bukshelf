# Bukshelf 0.1 Migration

## Goal

Bukshelf 0.1 is a self-hosting-first reader that preserves Readest's mature
Next.js/Tauri frontend while replacing its cloud-oriented backend with one Bun
process and one persistent data directory.

The Bun process will serve the built Next.js frontend as well as the Bukshelf
API. SQLite will hold structured data, while books and covers will remain
ordinary files.

```text
Bukshelf
├── Bun HTTP server
│   ├── built Next.js frontend
│   ├── authentication
│   ├── sync API
│   ├── book and cover delivery
│   ├── public bookshelf
│   ├── AI and TTS proxies
│   └── usage metering
└── /data
    ├── bukshelf.sqlite
    ├── books/
    ├── covers/
    ├── files/
    └── backups/
```

## Authentication

Authentication is intentionally minimal:

- The owner creates the password in a one-time browser setup screen.
- The server stores a strong password hash, never the password.
- Web sessions use secure cookies; native clients use scoped bearer sessions.
- Account recovery is an explicit CLI command run on the server.
- There are no recovery emails, social providers, invitations, subscriptions,
  or multi-user administration in 0.1.

## Iterative Strategy

1. Get everything running now just as it was before. Stay off port 3000 and use
   uncommon ports so all migration environments can remain running together.
2. Start a Bun application alongside the existing stack, leaving three primary
   development servers running at once.
3. Pick one small backend responsibility and move it to Bun.
4. Test the complete application after the move.
5. Repeat steps 3 and 4 until the legacy backend is gone and only the Bun server
   remains.

## Development Rules

- This is a development environment with zero active users.
- Do not add backward-compatibility features unless they are required to keep
  the current migration step testable.
- Do not avoid a correct change because it might break a production environment;
  no production environment exists.
- Treat this as an end-to-end evaluation with many independently verified steps.
- Preserve client behavior and useful frontend integration contracts, not the
  legacy backend's internal topology.
- Keep migration notes brief. This is the only migration document and it must
  remain below 300 lines.

## Migration Order

Prefer narrow, observable slices:

1. Health, capability discovery, and Bun static-file serving
2. Public bookshelf and cover delivery
3. Owner bootstrap, login, sessions, and CLI password reset
4. Book and cover uploads/downloads
5. Library metadata and incremental synchronization
6. Reading progress, notes, and settings synchronization
7. Reader AI, TTS, and usage metering
8. Backups, migration tooling, and removal of legacy services

Every slice ends with linting, automated tests, a production build, and a live
browser/native smoke test appropriate to the changed behavior.

## Current State

- Postgres and MinIO are no longer part of the default runtime or its
  Compose stack. `docker compose up` (docker/compose.yaml) starts only the
  Bukshelf image: one process, SQLite, and a filesystem data directory. The
  legacy Supabase/Postgres/MinIO/Kong stack survives only as
  `docker/compose.legacy-migration.yaml`, brought up temporarily so the
  one-time importers (`pnpm import:bukshelf`, `auth:import-legacy`) can read
  an existing pre-Bukshelf deployment's data; it is not started by default
  and the importers never require its `client`/`auth` services to be
  reachable, only `db` and `minio`.
- Book sharing (create/list/revoke/cover/download/download-confirm/import)
  moved from Postgres (`book_shares`) + MinIO presigned URLs to
  `bukshelf.sqlite` + the existing filesystem object store. Single-owner
  simplifies the model considerably: no `user_id`/RLS, and cover/download
  bytes are served directly (no presigning — the API and the bytes are the
  same host now). The `/s/[token]` landing page and its OG image stay
  Next.js routes (next/og has no Bun equivalent) but now read share state
  through Bun's public endpoints over loopback instead of Supabase.
- The web frontend is branded Bukshelf and exposes a safe public bookshelf.
- Soniox TTS, OpenRouter Reader AI, and provider usage metering are working.
- Reader AI is deliberately long-context rather than retrieval-augmented: the
  browser extracts literal chapter text and sends a bounded context directly
  to the chat model. The embedding endpoint, vector/BM25 indexes, Reedy/Turso
  retrieval runtime, indexing UI, and embedding-model settings are removed.
- The Bun migration server supplies health and capability discovery endpoints,
  can serve a configured static web bundle, and now owns the anonymous public
  bookshelf and cover-delivery API.
- The public shelf frontend calls Bun directly. Its former Next.js API routes
  have been removed.
- Bun now owns classic library synchronization (books, configs, notes, reading
  statistics), CRDT replicas (settings, dictionaries, fonts, textures, OPDS),
  and replica passphrase salts in `bukshelf.sqlite`.
- The classic sync tables are consolidated into one indexed JSON record table;
  replicas retain a dedicated table because field-level HLC merging is a real
  semantic difference, not legacy topology worth preserving.
- The signed-out catalog now reads SQLite plus local cover files. Postgres and
  MinIO participate only in the explicit, idempotent one-time import command.
- Bun now owns the single owner's password hash and session registry in
  `bukshelf.sqlite`. Web login uses an HttpOnly cookie plus a bearer token for
  the existing frontend API contract; login no longer calls GoTrue.
- The existing owner's UUID, email, and bcrypt hash were imported once without
  copying or logging a plaintext password. Fresh installs use `auth:setup`.
- The unified data directory now contains `bukshelf.sqlite`, imported books,
  imported covers, private files, and temporary writes. Public cover delivery
  no longer reads MinIO and remains available when MinIO is stopped.
- Authenticated books, covers, and replica binaries now upload and download
  directly through Bun. Bun streams uploads to an atomic temporary file and
  keeps file metadata in the existing SQLite database; the path contains no
  S3 signing request, MinIO transfer, PostgREST call, or upload-confirmation
  round trip.
- File listing, storage statistics, individual deletion, and bulk purge are
  also Bun/SQLite operations. Self-hosted storage has no artificial quota.
- Bun idempotently indexes already-imported hash-keyed books and covers into
  SQLite at startup, so the Storage Manager is complete without Postgres.
- Imported hash-keyed books and covers remain readable through a narrow
  filesystem bridge, so migration does not require a second copy. Temporary
  public image uploads used by Discord presence remain on the legacy route;
  they are not part of the private bookshelf storage path.
- The legacy stack and Bun server have been smoke-tested concurrently without
  changing the existing Postgres or MinIO data volumes.
- The real owner metadata import contains 1 book, 1 config, 2 notes, 1 stats
  book, and 70 page events; Bun's live incremental API returns the same keyset.
- Reader AI, Soniox TTS, and usage metering have moved into Bun. The frontend
  calls `POST/GET /api/ai/chat`, `POST/GET /api/tts/soniox`, and
  `/api/usage[/summary|/events]` on the Bukshelf origin directly; there is no
  fallback to Next.js routes, which have been deleted along with the in-memory
  usage meters.
- OpenRouter chat is a streaming OpenAI-compatible proxy: SSE deltas are
  re-emitted as plain text, exact token counts and provider cost come from the
  final usage chunk, and a client-supplied AI Gateway key passes through
  unmetered. Soniox TTS keeps tts-rt-v2/Kayla MP3 behavior with queueing,
  per-minute, and daily budgets; its locally recorded units are always marked
  estimated because Soniox reports tokens only in its own logs.
- Every provider request is recorded in `provider_usage_events` in
  `bukshelf.sqlite` (provider, operation, model, status, HTTP/provider status,
  input/output/total units, exact-vs-estimated flag, cost plus cost source,
  duration, sanitized error category). Daily token budgets are enforced from
  these rows, so limits survive restarts. Logs carry sizes, fingerprints,
  timings, and status codes — never prompt text or API keys.
- The usage dashboard reads persistent local accounting (today, session since
  boot, all-time) alongside provider-reported billing from OpenRouter's key
  endpoint and Soniox's usage summary.
- Bun has inspectable directory backups for SQLite, books, covers, and private
  files. Each snapshot has a SHA-256 manifest; restore verifies every byte and
  stages replacements before swapping the live data. Maintenance commands
  require the server to be stopped, and restore requires an explicit force flag.
- A minimal production Bun image and Compose service persist the whole server in
  one `/data` volume; no database or object-storage container is required.
- The production image build now uses Next's `output: 'standalone'` tracer
  (`BUILD_STANDALONE`, next.config.mjs) instead of copying `.next` next to a
  flattened `pnpm deploy` tree. The prior approach shipped Turbopack's
  externalized-dependency symlinks pointing at a pnpm store the runtime image
  never had, so SSR of any page touching one of those packages failed at
  request time while still returning 200 (Next degraded silently to client
  rendering). The image also dropped from 2.94GB to 1.04GB as a result, since
  the traced tree replaces the full frontend `node_modules`.

## Development Runtime

| Purpose | Address |
| --- | --- |
| Bukshelf | `http://localhost:43175` |
| Legacy stack (migration only, `compose.legacy-migration.yaml`) | ports `43171`-`43176`, see docker/README.md |

Run the Bun server from the repository root with `pnpm dev:bukshelf`. Use
`pnpm dev:bukshelf:fresh` to erase the repository-local Bukshelf development
data directory and relaunch the complete first-run flow. Its
discovery document is at `/.well-known/bukshelf` and advertises only capabilities
that have actually migrated.

## Frontend Boundary

- Keep the Next.js frontend able to receive ongoing upstream Readest improvements.
- Bun is now the single public process and HTTP listener. It hosts Next in-process:
  migrated API paths run directly in Bun, while pages and remaining legacy API
  routes pass to Next without a proxy or child process.

## Verification

- Bun handler tests cover discovery, catalog privacy, image validation, CORS,
  static assets, authenticated streamed file transfers, SQLite file metadata,
  metering, bulk deletion, traversal rejection, and missing routes.
- A separate Playwright lane boots an ephemeral unified Bun/Next server with
  SQLite/filesystem storage on port 43281. It verifies the public shelf, cover
  privacy, invalid and valid owner login, private library sync, authenticated
  book/cover downloads, direct Bun routing, and session restoration without
  touching development data.
- The production web build, full frontend type check/lint, Compose validation,
  and live catalog/cover requests pass.
- `pnpm test:docker:bukshelf` proves fresh-volume setup, cold start, HTTP writes,
  stopped-server backup, destructive mutation, restore into a new container,
  and recovery of authentication, SQLite metadata, and book bytes — run
  against the restructured `docker/compose.yaml` (Bukshelf-only, Postgres/
  MinIO no longer present) after the sharing migration, unchanged result.
- Share HTTP-contract tests cover create/list/revoke/cover/download/confirm/
  import, the active-share cap, expiry/revocation/source-deletion rejection,
  and idempotent revoke.
- The signed-out page renders the real SQLite catalog through Bun with no
  browser console errors. Runtime configuration points authenticated library,
  file, classic sync, replica sync, and replica-key traffic directly at Bun.
- `pnpm test:e2e:bukshelf` (dev mode, fast) and `pnpm test:e2e:bukshelf:prod`
  (real `output: 'standalone'` build) are separate lanes. `next dev` never
  exercises Turbopack's externalized-dependency packaging, so only the prod
  lane can catch a bug like the one above; it asserts on the server process's
  own `unhandledRejection`/`uncaughtException` output, not just page/browser
  state, since a packaging failure there doesn't surface as a bad HTTP status
  or a console error.

## Owner Commands

Run these from the repository root. Password prompts are hidden; automation may
append `-- --password-stdin` and provide one line on standard input.

```text
pnpm --dir apps/bukshelf-server auth:setup
pnpm --dir apps/bukshelf-server auth:import-legacy
pnpm --dir apps/bukshelf-server auth:reset
pnpm dev:bukshelf:fresh
pnpm backup:bukshelf create
pnpm backup:bukshelf verify <backup-directory>
pnpm backup:bukshelf restore <backup-directory> --force
```

`auth:reset` revokes every active session. An empty server starts in setup mode;
the owner supplies their email and password there, and the setup endpoint
permanently closes after that account is created.

## Next Step

Stripe is removed (routes, libs, UI, npm deps); IAP (Apple/Google) is kept as
the only purchase path. Neither was ever provisioned in the self-hosted
schema, so this was a deletion, not a migration. The remaining Next.js
routes with no Postgres/MinIO coupling at all (translation providers,
metadata search, OPDS proxying, Hardcover, Edge TTS) are a straightforward
port into Bun whenever picked up, not a data migration.
