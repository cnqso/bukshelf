# Self-hosting Bukshelf

Bukshelf is one Bun process, one SQLite database, and one filesystem data
directory. The process serves the Next.js frontend and every Bukshelf API on
the same origin.

## Start with Compose

```bash
cd docker
cp .env.example .env
docker compose up -d
```

Open `http://localhost:43175` and create the single owner account. Before
exposing the server, replace `BUKSHELF_SESSION_SECRET` in `.env` with a random
secret of at least 32 characters.

The only service is `bukshelf`; its persistent named volume contains:

- `bukshelf.sqlite`
- book and cover files
- temporary upload files
- backups

Stop the server with `docker compose down`. To perform a complete factory
reset, including all books and owner credentials, use `docker compose down -v`.

## Optional services

Set `OPENROUTER_API_KEY` to enable server-managed Reader AI. Requests are
authenticated, rate-limited, and metered in SQLite; prompts are not logged.

Set `SONIOX_API_KEY` to enable Soniox `tts-rt-v2` with the Kayla voice. TTS
requests are also authenticated, rate-limited, and metered without logging the
book text.

The relevant limits are documented in [`.env.example`](.env.example).

## Public shelf and branding

```env
SELF_HOSTED_BRAND_NAME=Bukshelf
SELF_HOSTED_PUBLIC_LIBRARY=true
SELF_HOSTED_SOURCE_URL=https://github.com/your-name/bukshelf
SELF_HOSTED_PRIVACY_MODE=true
SELF_HOSTED_PREMIUM_FEATURES=true
```

Signed-out visitors see book titles, authors, and same-origin cover URLs. Book
files, storage keys, settings, and reading data remain authenticated.

## Custom domain

```env
SITE_URL=https://books.example.com
API_BASE_URL=https://books.example.com
BUKSHELF_API_PUBLIC_URL=https://books.example.com
BUKSHELF_SECURE_COOKIES=true
```

[`nginx.conf.example`](nginx.conf.example) is a starting point for terminating
TLS and forwarding the domain to `127.0.0.1:43175`.

For self-hosted CJK fonts, mirror the required font bundles and set
`FONT_BASE_URL=https://books.example.com/fonts`.

## Build and run directly

```bash
docker build -f apps/bukshelf-server/Dockerfile -t bukshelf .
docker run -p 43175:43175 \
  -v bukshelf-data:/data \
  -e BUKSHELF_AUTH_ENABLED=true \
  -e SITE_URL=http://localhost:43175 \
  -e API_BASE_URL=http://localhost:43175 \
  -e BUKSHELF_API_PUBLIC_URL=http://localhost:43175 \
  -e BUKSHELF_SESSION_SECRET=<a-strong-32-plus-char-secret> \
  bukshelf
```

The `packages/foliate-js` and `packages/simplecc-wasm` submodules must be
initialized before a local image build:

```bash
git submodule update --init packages/foliate-js packages/simplecc-wasm
```

## Backups

Use the repository commands described in [`BUKSHELF_0.1.md`](../BUKSHELF_0.1.md)
to create, verify, and restore backups. Stop the server before restoring so the
SQLite database and filesystem snapshot cannot diverge.
