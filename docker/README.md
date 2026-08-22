# Self-Hosting with Docker/Podman with Compose

Bukshelf is one Bun process, SQLite, and a filesystem data directory — no
database or object-storage container required. `docker compose up` starts
this and nothing else. See [`BUKSHELF_0.1.md`](../BUKSHELF_0.1.md) for the
full architecture.

## Stack

| service      | Image                       | Description                          |
| ------------ | ---------------------------- | ------------------------------------- |
| **bukshelf** | built from `apps/bukshelf-server/Dockerfile` | frontend + API + SQLite + book storage |

### Exposed ports

| Default port | Service  | Variable            |
| ------------- | -------- | -------------------- |
| `43175`       | Bukshelf | `BUKSHELF_HOST_PORT` |

---

## Running with Docker/Podman Compose

### 1. setup .env

```bash
cd docker
cp .env.example .env
```

update `docker/.env`:

- set `BUKSHELF_SESSION_SECRET` to a strong random secret (32+ chars)
- optionally set `OPENROUTER_API_KEY` / `SONIOX_API_KEY` for Reader AI / TTS

### 2. Start the stack

```bash
cd docker
docker compose up -d
```

this builds the image locally from `apps/bukshelf-server/Dockerfile`.

> **Prerequisites for local builds**: the `packages/foliate-js` and
> `packages/simplecc-wasm` git submodules must be initialized:
> ```bash
> git submodule update --init packages/foliate-js packages/simplecc-wasm
> ```
> In GitHub Codespaces this is done automatically via
> `.devcontainer/devcontainer.json`.

To pull a published image instead of building locally, set `BUKSHELF_IMAGE`
in `docker/.env`:

```env
BUKSHELF_IMAGE=ghcr.io/readest/bukshelf:latest
```

published tags:
- `latest`: rolling image from the default branch and from release events
- `<release-tag>` (for example `v1.2.3`): published from release events
- `main`: rolling image from the default branch
- `sha-<commit>`: immutable commit tag

### 3. First-run setup

Open `http://localhost:43175` and follow the setup flow to create the single
owner account — see [`BUKSHELF_0.1.md`](../BUKSHELF_0.1.md#owner-commands)
for the CLI equivalent and password-reset commands.

set `SELF_HOSTED_PRIVACY_MODE=true` to prevent PostHog from initializing. To
enable Reader AI without exposing a credential to the browser, set
`OPENROUTER_API_KEY`; long-context chat requests then pass through an
authenticated Bun route. The browser extracts literal chapter text
locally — there is no embedding or retrieval service. The default guardrails
are 900,000 input characters per request, 2 concurrent requests, 30 requests
per minute, 5,000,000 tokens per UTC day, and 2,048 output tokens per
response. Signed-in users can open **Advanced Settings → Usage & Costs** to
compare the live local safety meters with exact Soniox and OpenRouter
provider billing.

For a single-owner white-label deployment, set `SELF_HOSTED_BRAND_NAME`; the
owner supplies their email during first-run setup. Setting
`SELF_HOSTED_PUBLIC_LIBRARY=true` replaces the signed-out home screen with a
read-only catalog for that account. Its API returns only a synthetic ID,
title, author, and same-origin cover URL; cover bytes are proxied so book
hashes and file paths are not disclosed. Set `SELF_HOSTED_SOURCE_URL` to the
public source for the exact modified build when making an AGPL-covered
deployment available over a network.

### Stop the stack

```bash
cd docker
docker compose down
```

to also remove the data volume (SQLite database, books, covers, backups):

```bash
cd docker
docker compose down -v
```

---

## Migrating from a pre-Bukshelf install

If you have an existing Readest self-hosted deployment (Supabase/Postgres +
MinIO, from before this migration), bring that stack back up temporarily,
pointed at its **original data volumes**, and run the one-time importers
against it. The importers talk directly to Postgres and MinIO — the legacy
web client does not need to be reachable or correctly configured for this.

```bash
cd docker
# Uses your existing data volumes: run this from the same directory (and
# with the same project name) your old deployment used, so Compose finds them.
docker compose -f compose.legacy-migration.yaml up -d db minio
```

Then, from the repository root, with `docker/.env` pointing `POSTGRES_*` /
`MINIO_*` at that stack (the defaults in `.env.example` already match it):

```bash
# Imports books, covers, classic sync metadata (configs/notes/reading
# stats), and CRDT replicas for one account. Safe to re-run.
pnpm import:bukshelf --owner-email owner@example.com

# Imports the owner's password hash directly (no plaintext copy) so the
# same password keeps working.
pnpm --dir apps/bukshelf-server auth:import-legacy --email owner@example.com
```

Once both commands report success, start Bukshelf (`docker compose up -d`
from `docker/`, no `-f` flag needed) and confirm your library, settings, and
login all carried over. Then tear down the legacy stack for good:

```bash
cd docker
docker compose -f compose.legacy-migration.yaml down -v
```

`compose.legacy-migration.yaml`, `compose.build.yaml`, and `compose.dev.yaml`
are the full pre-Bukshelf stack (Supabase Postgres, Kong, GoTrue, PostgREST,
MinIO, and the legacy Next-only client) — see
[Database schema](#database-schema) below if you're inspecting or manually
patching that database during a migration. None of this runs by default.

---

## Database schema (legacy stack only)

| path                          | role                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `volumes/db/init/schema.sql`  | base schema (books, book_configs, book_notes, files)                         |
| `volumes/db/migrations/*.sql` | every schema change since, applied in filename order                         |
| `volumes/db/apply-migrations.sh` | applies the migrations and records them in `readest_meta.migrations`      |

on an empty database volume the supabase image runs everything under
`/docker-entrypoint-initdb.d` in glob order: its own `migrate.sh` (supabase core
schema plus `init-scripts/100-schema.sql`, which is `schema.sql`), then
`zz-readest-migrations.sh`, which is `apply-migrations.sh`. it globs the mounted
migrations directory, so adding a migration file needs no compose change.

---

## Serving from a custom domain

```env
SITE_URL=https://your-domain.com
API_BASE_URL=https://your-domain.com
BUKSHELF_API_PUBLIC_URL=https://your-domain.com
BUKSHELF_SECURE_COOKIES=true
```

Putting everything on one origin means no cross-origin requests at all.
`nginx.conf.example` is a working starting point for terminating TLS in
front of the stack.

### CJK fonts on a custom domain

the reader loads a few CJK webfont bundles from Readest's CDN, which only sends
`Access-Control-Allow-Origin` for readest.com origins, so the browser blocks them
on a self-hosted domain. mirror
`https://storage.readest.com/public/font/dist/<Family>/` (and the `.woff2` files it
references) onto a path your proxy serves, then point the client at it:

```env
FONT_BASE_URL=https://your-domain.com/fonts
```

leaving `FONT_BASE_URL` empty keeps the default CDN. system and Google fonts are
unaffected either way.

### Soniox text-to-speech

Set `SONIOX_API_KEY` to enable the server-side Soniox provider. Readest uses
`tts-rt-v2` with the Kayla voice and never sends the API key to the browser.
Each request emits a structured JSON log containing its request/user IDs,
language, character count, estimated tokens, latency, status, audio bytes, and
cumulative usage; the synthesized book text is not logged.

The defaults allow two concurrent upstream requests with 32 waiting requests,
90 requests per minute, 20,000 estimated tokens per user per minute, and
500,000 estimated tokens per UTC day.
Override them with `SONIOX_TTS_MAX_CONCURRENT`, `SONIOX_TTS_MAX_QUEUE_SIZE`,
`SONIOX_TTS_REQUESTS_PER_MINUTE`,
`SONIOX_TTS_TOKENS_PER_MINUTE_PER_USER`, and `SONIOX_TTS_TOKENS_PER_DAY`.

---

## Building the Bukshelf image standalone

```bash
docker build \
  -f apps/bukshelf-server/Dockerfile \
  -t bukshelf \
  .
```

run the built image:

```bash
docker run -p 43175:43175 \
  -v bukshelf-data:/data \
  -e BUKSHELF_AUTH_ENABLED=true \
  -e SELF_HOSTED_PUBLIC_LIBRARY=true \
  -e SITE_URL=http://localhost:43175 \
  -e BUKSHELF_API_PUBLIC_URL=http://localhost:43175 \
  -e API_BASE_URL=http://localhost:43175 \
  -e BUKSHELF_SESSION_SECRET=<a-strong-32-plus-char-secret> \
  bukshelf
```
