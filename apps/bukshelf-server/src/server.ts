import { createHandler } from './app';
import { createLegacyPublicLibrary } from './publicLibrary';

const port = Number.parseInt(process.env.BUKSHELF_PORT ?? '43175', 10);
const legacyDatabaseUrl = `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? '43176'}/${encodeURIComponent(process.env.POSTGRES_DB ?? 'postgres')}`;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BUKSHELF_PORT: ${process.env.BUKSHELF_PORT}`);
}

const server = Bun.serve({
  hostname: process.env.BUKSHELF_HOST ?? '127.0.0.1',
  port,
  fetch: createHandler({
    webDir: process.env.BUKSHELF_WEB_DIR,
    publicOrigin: process.env.SITE_URL,
    publicLibrary:
      process.env.SELF_HOSTED_PUBLIC_LIBRARY?.toLowerCase() === 'true'
        ? createLegacyPublicLibrary({
            databaseUrl: process.env.BUKSHELF_DATABASE_URL ?? legacyDatabaseUrl,
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
