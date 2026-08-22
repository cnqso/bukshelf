import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { createHandler } from '../../../bukshelf-server/src/app';
import { AuthService } from '../../../bukshelf-server/src/auth';
import { AuthStore } from '../../../bukshelf-server/src/authStore';
import { FileStore } from '../../../bukshelf-server/src/fileStore';
import { createObjectStore } from '../../../bukshelf-server/src/objectStore';
import { createLocalPublicLibrary } from '../../../bukshelf-server/src/publicLibrary';
import { ReplicaStore } from '../../../bukshelf-server/src/replicaStore';
import { SyncStore } from '../../../bukshelf-server/src/syncStore';
import { startUnifiedServer } from '../../../bukshelf-server/src/unifiedServer';

/**
 * Same fixture as e2e/bukshelf, but boots against the real production
 * `.next/standalone` build (see build-web:standalone) instead of `next dev`.
 *
 * This exists because `next dev` resolves modules straight from the source
 * tree and never exercises Turbopack's server-externalized-dependency
 * packaging — the exact mechanism a shipped Docker image depends on. A
 * bug there (see apps/bukshelf-server/Dockerfile) can leave every page look
 * fine in the dev-mode lane and in the browser (Next silently falls back to
 * client rendering) while the server logs an unhandled rejection on every
 * request. Assert on `serverErrors` below, not just page/browser state.
 */

const E2E_OWNER_EMAIL = 'owner@bukshelf.test';
const E2E_OWNER_PASSWORD = 'bukshelf-e2e-password';

const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
const BOOK_HASH = 'bukshelf-e2e-book';
const PORT = 43_282;
const DIAGNOSTICS_PORT = 43_283;
const ORIGIN = `http://localhost:${PORT}`;

const appDir = resolve(import.meta.dir, '../..');
const standaloneAppDir = join(appDir, '.next/standalone/apps/readest-app');
if (!(await Bun.file(join(standaloneAppDir, 'package.json')).exists())) {
  console.error(
    `No production build at ${standaloneAppDir}. Run \`pnpm build-web:standalone\` first.`,
  );
  process.exit(1);
}

// output: 'standalone' traces and copies node_modules but deliberately
// excludes .next/static and public/ (served as files, not required as
// modules) — the same two directories apps/bukshelf-server/Dockerfile
// copies in separately alongside the standalone tree.
await $`rm -rf ${join(standaloneAppDir, '.next/static')} ${join(standaloneAppDir, 'public')}`;
await $`cp -r ${join(appDir, '.next/static')} ${join(standaloneAppDir, '.next/static')}`;
await $`cp -r ${join(appDir, 'public')} ${join(standaloneAppDir, 'public')}`;

const serverErrors: string[] = [];
const recordError = (label: string, reason: unknown) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  serverErrors.push(`${label}: ${detail}`);
  console.error(`[bukshelf-prod-fixture] ${label}:`, detail);
};
process.on('unhandledRejection', (reason) => recordError('unhandledRejection', reason));
process.on('uncaughtException', (error) => recordError('uncaughtException', error));

const dataDir = await mkdtemp(join(tmpdir(), 'bukshelf-playwright-prod-'));
const authStore = new AuthStore(join(dataDir, 'bukshelf.sqlite'));
authStore.createOwner({
  id: OWNER_ID,
  email: E2E_OWNER_EMAIL,
  passwordHash: await Bun.password.hash(E2E_OWNER_PASSWORD, { algorithm: 'argon2id' }),
});

const auth = new AuthService(
  authStore,
  'bukshelf-playwright-prod-session-secret-over-thirty-two-bytes',
);
const objects = createObjectStore({ root: dataDir });
await objects.init();
await objects.writeBook(BOOK_HASH, 'epub', new TextEncoder().encode('e2e book bytes'));
await objects.writeCover(
  BOOK_HASH,
  'png',
  Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  ),
);

const files = new FileStore(authStore.database, dataDir, objects);
await files.init();
const sync = new SyncStore(authStore.database);
sync.push(
  {
    books: [
      {
        hash: BOOK_HASH,
        metaHash: 'bukshelf-e2e-meta',
        format: 'EPUB',
        title: 'The Deterministic Shelf',
        author: 'Bukshelf Test Suite',
        tags: ['e2e'],
        progress: [0, 100],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        uploadedAt: 1_700_000_000_000,
      },
    ],
  },
  OWNER_ID,
);
const replicas = new ReplicaStore(authStore.database);

const unified = await startUnifiedServer({
  nextDir: standaloneAppDir,
  hostname: '127.0.0.1',
  port: PORT,
  dev: false,
  bukshelf: createHandler({
    auth,
    files,
    sync,
    replicas,
    publicOrigin: ORIGIN,
    publicLibrary: createLocalPublicLibrary(sync, objects),
    secureCookies: false,
  }),
});

// Test-only introspection, isolated on its own port. Real production code
// (unifiedServer.ts) is untouched — this never ships.
const diagnostics = Bun.serve({
  hostname: '127.0.0.1',
  port: DIAGNOSTICS_PORT,
  fetch: () => Response.json({ errors: serverErrors }),
});

console.log(`Unified Bukshelf production-build fixture listening on ${ORIGIN}`);
console.log(`Server-error diagnostics at http://localhost:${DIAGNOSTICS_PORT}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  diagnostics.stop();
  await unified.close();
  authStore.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
