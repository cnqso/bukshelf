import { createHandler } from './app';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { getDatabasePath, getLegacyDatabaseUrl } from './config';
import { createLegacyPublicLibrary } from './publicLibrary';

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

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BUKSHELF_PORT: ${process.env.BUKSHELF_PORT}`);
}

const server = Bun.serve({
  hostname: process.env.BUKSHELF_HOST ?? '127.0.0.1',
  port,
  fetch: createHandler({
    webDir: process.env.BUKSHELF_WEB_DIR,
    publicOrigin: process.env.SITE_URL,
    auth,
    secureCookies,
    publicLibrary:
      process.env.SELF_HOSTED_PUBLIC_LIBRARY?.toLowerCase() === 'true'
        ? createLegacyPublicLibrary({
            databaseUrl: getLegacyDatabaseUrl(),
            ownerEmail: process.env.SELF_HOSTED_OWNER_EMAIL ?? '',
            s3Endpoint:
              process.env.BUKSHELF_S3_ENDPOINT ??
              `http://127.0.0.1:${process.env.MINIO_API_PORT ?? '43173'}`,
            s3Region: process.env.S3_REGION ?? 'us-east-1',
            s3Bucket: process.env.S3_BUCKET_NAME ?? '',
            s3AccessKeyId: process.env.MINIO_ROOT_USER ?? '',
            s3SecretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? '',
          })
        : undefined,
  }),
});

console.log(`Bukshelf migration server listening on ${server.url}`);
