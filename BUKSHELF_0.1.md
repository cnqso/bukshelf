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
- A Bun migration server now supplies health and capability discovery endpoints
  and can serve a configured static web bundle.
- The legacy stack and Bun server have been smoke-tested concurrently without
  changing the existing Postgres or MinIO data volumes.

## Development Runtime

| Purpose | Address |
| --- | --- |
| Legacy Next.js web app | `http://localhost:43171` |
| Legacy Supabase gateway | `http://localhost:43172` |
| Legacy MinIO API | `http://localhost:43173` |
| Legacy MinIO console | `http://localhost:43174` |
| Bun migration server | `http://localhost:43175` |

Run the Bun server from the repository root with `pnpm dev:bukshelf`. Its
discovery document is at `/.well-known/bukshelf` and advertises only capabilities
that have actually migrated.

## Frontend Boundary

- Keep the Next.js frontend able to receive ongoing upstream Readest improvements.
- The final self-hosted artifact runs the frontend and API from one Bun process.

## Next Step

Move the public bookshelf catalog and cover delivery to Bun, point only those
frontend requests at it, and verify signed-out and signed-in library behavior
before migrating authentication.
