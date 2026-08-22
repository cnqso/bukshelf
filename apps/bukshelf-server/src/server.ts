import { createHandler } from './app';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { getDatabasePath } from './config';
import { createObjectStore } from './objectStore';
import { createLocalPublicLibrary } from './publicLibrary';
import { FileStore } from './fileStore';
import { SyncStore } from './syncStore';
import { ReplicaStore } from './replicaStore';
import { UsageStore } from './usageStore';
import { OpenRouterService, createOpenRouterConfigFromEnv } from './openRouter';
import { SonioxService, createSonioxConfigFromEnv } from './soniox';
import { ShareStore } from './shareStore';
import { resolve } from 'node:path';
import { startUnifiedServer } from './unifiedServer';

const port = Number.parseInt(process.env.BUKSHELF_PORT ?? '43175', 10);
const authEnabled = process.env.BUKSHELF_AUTH_ENABLED?.toLowerCase() === 'true';
const secureCookies =
  process.env.BUKSHELF_SECURE_COOKIES === undefined
    ? process.env.SITE_URL?.startsWith('https://') === true
    : process.env.BUKSHELF_SECURE_COOKIES.toLowerCase() === 'true';
const authStore = authEnabled ? new AuthStore(getDatabasePath()) : undefined;
const auth = authStore
  ? new AuthService(authStore, process.env.BUKSHELF_SESSION_SECRET ?? process.env.JWT_SECRET ?? '')
  : undefined;

if (authEnabled && !auth?.owner) {
  console.log('Bukshelf needs first-run setup; open /auth to create the owner');
}

const publicLibraryEnabled = process.env.SELF_HOSTED_PUBLIC_LIBRARY?.toLowerCase() === 'true';
const dataDir = process.env.BUKSHELF_DATA_DIR;
const objectStore = dataDir ? createObjectStore({ root: dataDir }) : undefined;
const files =
  authStore && dataDir ? new FileStore(authStore.database, dataDir, objectStore) : undefined;
await files?.init();
const sync = authStore ? new SyncStore(authStore.database) : undefined;
const replicas = authStore ? new ReplicaStore(authStore.database) : undefined;
const usage = authStore ? new UsageStore(authStore.database) : undefined;
const shares = authStore ? new ShareStore(authStore.database) : undefined;
const openRouter =
  authStore && usage ? new OpenRouterService(createOpenRouterConfigFromEnv(), usage) : undefined;
const soniox =
  authStore && usage ? new SonioxService(createSonioxConfigFromEnv(), usage) : undefined;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BUKSHELF_PORT: ${process.env.BUKSHELF_PORT}`);
}

if (publicLibraryEnabled && !dataDir) {
  throw new Error(
    'BUKSHELF_DATA_DIR is required when SELF_HOSTED_PUBLIC_LIBRARY is true. ' +
      'Set it (see docker/.env.example) and run `pnpm import:bukshelf` once.',
  );
}

const hostname = process.env.BUKSHELF_HOST ?? '127.0.0.1';
const handler = createHandler({
  webDir: process.env.BUKSHELF_WEB_DIR,
  publicOrigin: process.env.SITE_URL,
  auth,
  files,
  sync,
  replicas,
  secureCookies,
  providers: usage ? { usage, openRouter, soniox } : undefined,
  shares,
  objects: objectStore,
  publicLibrary:
    publicLibraryEnabled && objectStore && sync
      ? createLocalPublicLibrary(sync, objectStore)
      : undefined,
});

const nextDir = process.env.BUKSHELF_NEXT_DIR?.trim();
if (nextDir) {
  await startUnifiedServer({
    bukshelf: handler,
    nextDir: resolve(nextDir),
    hostname,
    port,
    dev: process.env.NODE_ENV !== 'production',
  });
  console.log(`Bukshelf + Next listening on http://${hostname}:${port}/`);
} else {
  const server = Bun.serve({ hostname, port, fetch: handler });
  console.log(`Bukshelf API listening on ${server.url}`);
}
