import { createHandler } from './app';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { getDatabasePath, getLegacyDatabaseUrl } from './config';
import { createObjectStore } from './objectStore';
import { createLegacyPublicLibrary } from './publicLibrary';
import { FileStore } from './fileStore';

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
  throw new Error(
    'Bukshelf owner is not configured. Run: pnpm --dir apps/bukshelf-server auth:setup',
  );
}

const publicLibraryEnabled = process.env.SELF_HOSTED_PUBLIC_LIBRARY?.toLowerCase() === 'true';
const dataDir = process.env.BUKSHELF_DATA_DIR;
const objectStore = dataDir ? createObjectStore({ root: dataDir }) : undefined;
const files =
  authStore && dataDir ? new FileStore(authStore.database, dataDir, objectStore) : undefined;
await files?.init();

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BUKSHELF_PORT: ${process.env.BUKSHELF_PORT}`);
}

if (publicLibraryEnabled && !dataDir) {
  throw new Error(
    'BUKSHELF_DATA_DIR is required when SELF_HOSTED_PUBLIC_LIBRARY is true. ' +
      'Set it (see docker/.env.example) and run `pnpm import:bukshelf` once.',
  );
}

const server = Bun.serve({
  hostname: process.env.BUKSHELF_HOST ?? '127.0.0.1',
  port,
  fetch: createHandler({
    webDir: process.env.BUKSHELF_WEB_DIR,
    publicOrigin: process.env.SITE_URL,
    auth,
    files,
    secureCookies,
    publicLibrary:
      publicLibraryEnabled && dataDir
        ? createLegacyPublicLibrary({
            databaseUrl: getLegacyDatabaseUrl(),
            ownerEmail: process.env.SELF_HOSTED_OWNER_EMAIL ?? '',
            store: objectStore!,
          })
        : undefined,
  }),
});

console.log(`Bukshelf migration server listening on ${server.url}`);
