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
- The final self-hosted artifact runs the frontend and API from one Bun process.

## Verification

- Bun handler tests cover discovery, catalog privacy, image validation, CORS,
  static assets, authenticated streamed file transfers, SQLite file metadata,
  metering, bulk deletion, traversal rejection, and missing routes.
- The production web build, full frontend type check/lint, Compose validation,
  and live catalog/cover requests pass.
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
```

`auth:reset` revokes every active session. The server refuses to start with
`BUKSHELF_AUTH_ENABLED=true` until an owner has been configured.

## Parallel Work Lanes

Two slices can now proceed independently from commit `b711b6a59`:

1. **Codex: single-owner authentication (complete).** First-run setup, password
   hashing, cookie and bearer sessions, logout, legacy credential import, and
   CLI password reset now run in Bun.
2. **Claude: filesystem object storage (complete).** MinIO objects have an
   idempotent importer into the ordinary data directory, and the public cover
   endpoint now serves validated local files with the CORP header required by
   the COEP-isolated frontend.

The storage lane is deliberately metadata-light: it does not migrate Postgres
library records, authenticated upload/download routes, or synchronization. That
keeps it independent from the authentication work while removing one complete
piece of MinIO from the live path.

## Claude Lane Record: Filesystem Storage

The `claude/filesystem-storage` lane started from `b711b6a59` and was integrated
after the authentication lane as five small commits, keeping route wiring
separate from the storage foundation.

### Objective

After one explicit import command, Bun must serve public covers from
`BUKSHELF_DATA_DIR` without contacting MinIO. The import is a development
migration, not a permanent compatibility layer.

### Required data layout

```text
$BUKSHELF_DATA_DIR/
├── books/<book-hash>/book.<format>
├── covers/<book-hash>/cover.<image-extension>
└── tmp/
```

Keep paths deterministic and independent of the legacy user UUID. Reject path
traversal, symlinks escaping the data root, unsupported cover formats, and
untrusted absolute paths. Writes must use a temporary file followed by an
atomic rename.

### Scope

- Add a small Bun-native filesystem object-store module and focused tests.
- Add an idempotent CLI import command that reads live, non-deleted `files` rows
  from legacy Postgres and copies their MinIO objects into the layout above.
- Support at least EPUB/PDF book objects and PNG/JPEG/WebP/GIF covers. Report
  copied, skipped, missing, and failed counts without printing credentials.
- A rerun must safely skip byte-identical destinations. A conflicting existing
  destination must fail loudly unless an explicit overwrite flag is supplied.
- Refactor `src/publicLibrary.ts` so cover bytes come from the filesystem after
  import. Postgres may remain the temporary source of catalog metadata and the
  opaque cover-ID lookup.
- Add configuration examples for `BUKSHELF_DATA_DIR`; never commit secrets or a
  developer-specific absolute path.
- Update capability discovery only if the advertised meaning remains accurate.

### Ownership and conflict boundary

Claude owns new storage/importer modules, their tests, `src/publicLibrary.ts`,
and storage-related package scripts/config examples. Codex owns authentication,
frontend auth pages, session middleware, and auth-specific SQLite code.

Avoid editing `src/app.ts`, `src/server.ts`, or this document unless absolutely
necessary. If integration needs those files, put only that wiring in a final,
separate commit and explain the required environment variables in its message.
Do not modify the public API response schema or expose book hashes/file keys.

### Acceptance checks

1. New storage/importer tests pass under `bun test`.
2. The importer succeeds against the current local Postgres/MinIO stack and a
   second run is a no-op with accurate counts.
3. The real public JPEG is served with its existing MIME type and cache headers
   after Bun is configured with the imported data directory.
4. Public catalog and cover delivery continue working when MinIO is unavailable
   or Bun is deliberately given an invalid MinIO endpoint after import.
5. `pnpm lint`, `pnpm --filter @readest/readest-app build-web`, Compose config
   validation, and `git diff --check` pass.
6. The worktree contains no imported books, covers, credentials, logs, or other
   runtime data. Commit the completed lane and report its commit hashes.

All six checks passed after integration. The combined suite had 30 passing Bun
tests, the production browser renders the real filesystem cover with MinIO
stopped, and the primary checkout contains no tracked runtime data.

## Next Step

Move the now chat-only Reader AI proxy, Soniox TTS, and their usage meter from
Next.js routes into Bun. Reader AI needs one streaming OpenRouter route—there
is no embedding or retrieval service to migrate.
After that, audit sharing and ancillary integrations, produce the static web
bundle, and remove the legacy Supabase/Postgres/MinIO services from the default
runtime entirely.
