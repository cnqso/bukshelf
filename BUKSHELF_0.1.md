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

- The owner sets the password during initial server startup.
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

- The existing Docker/Supabase/MinIO stack runs locally on uncommon ports.
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

## Development Runtime

| Purpose | Address |
| --- | --- |
| Legacy Next.js web app | `http://localhost:43171` |
| Legacy Supabase gateway | `http://localhost:43172` |
| Legacy MinIO API | `http://localhost:43173` |
| Legacy MinIO console | `http://localhost:43174` |
| Bun migration server | `http://localhost:43175` |
| Legacy Postgres bridge (migration only) | `localhost:43176` |

Run the Bun server from the repository root with `pnpm dev:bukshelf`. Its
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
- A separate Playwright lane boots an ephemeral Bun/SQLite/filesystem backend
  and Next frontend on ports 43282/43281. It verifies the public shelf, cover
  privacy, invalid and valid owner login, private library sync, authenticated
  book/cover downloads, direct Bun routing, and session restoration without
  touching development data.
- The production web build, full frontend type check/lint, Compose validation,
  and live catalog/cover requests pass.
- `pnpm test:docker:bukshelf` proves fresh-volume setup, cold start, HTTP writes,
  stopped-server backup, destructive mutation, restore into a new container,
  and recovery of authentication, SQLite metadata, and book bytes.
- The signed-out page renders the real SQLite catalog through Bun with no
  browser console errors. Runtime configuration points authenticated library,
  file, classic sync, replica sync, and replica-key traffic directly at Bun.

## Owner Commands

Run these from the repository root. Password prompts are hidden; automation may
append `-- --password-stdin` and provide one line on standard input.

```text
pnpm --dir apps/bukshelf-server auth:setup
pnpm --dir apps/bukshelf-server auth:import-legacy
pnpm --dir apps/bukshelf-server auth:reset
pnpm backup:bukshelf create
pnpm backup:bukshelf verify <backup-directory>
pnpm backup:bukshelf restore <backup-directory> --force
```

`auth:reset` revokes every active session. The server refuses to start with
`BUKSHELF_AUTH_ENABLED=true` until an owner has been configured.

## Next Step

Audit the remaining Next.js routes (translation providers, sharing, payments,
metadata search, OPDS proxying, Hardcover, Edge TTS, KOReader sync, send-to-
reader) and choose between migrating, retaining, or deleting each one. After
that, produce the static web bundle served by Bun and remove the legacy
Supabase/Postgres/MinIO services from the default runtime entirely.
