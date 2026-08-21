import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHandler } from '../../../bukshelf-server/src/app';
import { AuthService } from '../../../bukshelf-server/src/auth';
import { AuthStore } from '../../../bukshelf-server/src/authStore';
import { FileStore } from '../../../bukshelf-server/src/fileStore';
import { createObjectStore } from '../../../bukshelf-server/src/objectStore';
import { createLocalPublicLibrary } from '../../../bukshelf-server/src/publicLibrary';
import { ReplicaStore } from '../../../bukshelf-server/src/replicaStore';
import { SyncStore } from '../../../bukshelf-server/src/syncStore';
import { startUnifiedServer } from '../../../bukshelf-server/src/unifiedServer';

const E2E_OWNER_EMAIL = 'owner@bukshelf.test';
const E2E_OWNER_PASSWORD = 'bukshelf-e2e-password';

const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
const BOOK_HASH = 'bukshelf-e2e-book';
const PORT = 43_281;
const ORIGIN = 'http://localhost:43281';

const dataDir = await mkdtemp(join(tmpdir(), 'bukshelf-playwright-'));
const authStore = new AuthStore(join(dataDir, 'bukshelf.sqlite'));
authStore.createOwner({
  id: OWNER_ID,
  email: E2E_OWNER_EMAIL,
  passwordHash: await Bun.password.hash(E2E_OWNER_PASSWORD, { algorithm: 'argon2id' }),
});

const auth = new AuthService(authStore, 'bukshelf-playwright-session-secret-over-thirty-two-bytes');
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
  nextDir: resolve(import.meta.dir, '../..'),
  hostname: '127.0.0.1',
  port: PORT,
  dev: true,
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

console.log(`Unified Bukshelf Playwright fixture listening on ${ORIGIN}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await unified.close();
  authStore.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
