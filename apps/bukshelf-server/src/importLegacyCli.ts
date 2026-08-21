#!/usr/bin/env bun
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQL } from 'bun';
import {
  type ImportEntry,
  type LegacyObjectSource,
  importLegacyObjects,
  redact,
} from './legacyImport';
import { createObjectStore } from './objectStore';
import { AuthStore } from './authStore';
import { getDatabasePath } from './config';
import { SyncStore, type SyncCollection } from './syncStore';
import { ReplicaStore, type ReplicaKeyRow, type ReplicaRow } from './replicaStore';
import { importLegacyMetadata, type LegacyMetadataSource } from './metadataImport';

/**
 * `bun run import` — copies the legacy MinIO objects listed in Postgres into
 * BUKSHELF_DATA_DIR. Safe to rerun: byte-identical destinations are skipped
 * and conflicting ones fail unless --overwrite is passed.
 */

const USAGE = `Usage: bun run import [options]

Options:
  --data-dir <path>      Destination data directory (default: $BUKSHELF_DATA_DIR)
  --owner-email <email>  Import only this account's files (required)
  --overwrite            Replace destinations that hold different bytes
  --verbose              Print one line per object
  -h, --help             Show this message
`;

const parseArgs = (argv: string[]) => {
  const options: {
    dataDir?: string;
    ownerEmail?: string;
    overwrite: boolean;
    verbose: boolean;
    help: boolean;
  } = {
    dataDir: process.env.BUKSHELF_DATA_DIR,
    ownerEmail: undefined,
    overwrite: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--overwrite') options.overwrite = true;
    else if (flag === '--verbose') options.verbose = true;
    else if (flag === '-h' || flag === '--help') options.help = true;
    else if (flag === '--data-dir') options.dataDir = argv[++index];
    else if (flag === '--owner-email') options.ownerEmail = argv[++index];
    else throw new Error(`Unknown option: ${flag}`);
  }

  return options;
};

const legacyDatabaseUrl = () =>
  process.env.BUKSHELF_DATABASE_URL ??
  `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? '43176'}/${encodeURIComponent(process.env.POSTGRES_DB ?? 'postgres')}`;

const createLegacySource = (ownerEmail?: string): LegacyObjectSource => {
  const database = new SQL(legacyDatabaseUrl());
  const bucket = process.env.S3_BUCKET_NAME ?? '';
  const storage = new S3Client({
    endpoint:
      process.env.BUKSHELF_S3_ENDPOINT ??
      `http://127.0.0.1:${process.env.MINIO_API_PORT ?? '43173'}`,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ROOT_USER ?? '',
      secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? '',
    },
  });

  return {
    async listFiles() {
      const rows = ownerEmail
        ? await database`
            SELECT f.id, f.book_hash, f.file_key
            FROM public.files f
            INNER JOIN auth.users u ON u.id = f.user_id
            WHERE f.deleted_at IS NULL
              AND lower(u.email) = lower(${ownerEmail})
            ORDER BY f.updated_at ASC
          `
        : await database`
            SELECT f.id, f.book_hash, f.file_key
            FROM public.files f
            WHERE f.deleted_at IS NULL
            ORDER BY f.updated_at ASC
          `;

      return rows.map((file: { id: string; book_hash: string | null; file_key: string }) => ({
        id: file.id,
        bookHash: file.book_hash,
        fileKey: file.file_key,
      }));
    },

    async readObject(fileKey) {
      try {
        const object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: fileKey }));
        return object.Body ? await object.Body.transformToByteArray() : null;
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw error;
      }
    },
  };
};

const createLegacyMetadataSource = (ownerEmail: string): LegacyMetadataSource => {
  const database = new SQL(legacyDatabaseUrl());
  let ownerId: string | null = null;
  const getOwnerId = async () => {
    if (ownerId) return ownerId;
    const rows =
      await database`SELECT id FROM auth.users WHERE lower(email) = lower(${ownerEmail}) LIMIT 1`;
    ownerId = rows[0]?.id ?? null;
    if (!ownerId) throw new Error(`Legacy owner not found: ${ownerEmail}`);
    return ownerId;
  };
  return {
    async rows(collection: SyncCollection) {
      const id = await getOwnerId();
      if (collection === 'books')
        return await database`SELECT * FROM public.books WHERE user_id = ${id}`;
      if (collection === 'configs')
        return await database`SELECT * FROM public.book_configs WHERE user_id = ${id}`;
      if (collection === 'notes')
        return await database`SELECT * FROM public.book_notes WHERE user_id = ${id}`;
      if (collection === 'stat_books')
        return await database`SELECT * FROM public.stat_books WHERE user_id = ${id}`;
      return await database`SELECT * FROM public.stat_pages WHERE user_id = ${id}`;
    },
    async replicas() {
      const id = await getOwnerId();
      return (await database`SELECT user_id, kind, replica_id, fields_jsonb, manifest_jsonb,
          deleted_at_ts, reincarnation, updated_at_ts, schema_version
        FROM public.replicas WHERE user_id = ${id}`) as unknown as ReplicaRow[];
    },
    async replicaKeys() {
      const id = await getOwnerId();
      const rows = await database`SELECT salt_id, alg, salt, created_at
        FROM public.replica_keys WHERE user_id = ${id} ORDER BY created_at ASC`;
      return rows.map(
        (row: { salt_id: string; alg: string; salt: Uint8Array; created_at: string | Date }) => ({
          saltId: row.salt_id,
          alg: row.alg,
          salt: Buffer.from(row.salt).toString('base64'),
          createdAt: new Date(row.created_at).toISOString(),
        }),
      ) as ReplicaKeyRow[];
    },
  };
};

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (!options.dataDir) {
    console.error('Set BUKSHELF_DATA_DIR or pass --data-dir. See docker/.env.example.');
    return 2;
  }

  const store = createObjectStore({ root: options.dataDir });
  console.log(`Importing legacy objects into ${store.root}`);

  const onEntry = options.verbose
    ? (entry: ImportEntry) =>
        console.log(`  ${entry.outcome.padEnd(7)} ${entry.fileKey} (${entry.reason})`)
    : undefined;

  const summary = await importLegacyObjects(createLegacySource(options.ownerEmail), store, {
    overwrite: options.overwrite,
    onEntry,
  });

  if (!options.ownerEmail) throw new Error('Pass --owner-email for the account to import');
  const authStore = new AuthStore(getDatabasePath());
  const metadata = await importLegacyMetadata(
    createLegacyMetadataSource(options.ownerEmail),
    new SyncStore(authStore.database),
    new ReplicaStore(authStore.database),
  );
  authStore.close();

  console.log(
    `copied=${summary.copied} skipped=${summary.skipped} missing=${summary.missing} failed=${summary.failed}`,
  );
  console.log(
    `metadata books=${metadata.books} configs=${metadata.configs} notes=${metadata.notes} ` +
      `statBooks=${metadata.statBooks} statPages=${metadata.statPages} ` +
      `replicas=${metadata.replicas} replicaKeys=${metadata.replicaKeys}`,
  );

  for (const entry of summary.entries) {
    if (entry.outcome === 'failed') console.error(`  failed: ${entry.fileKey} (${entry.reason})`);
  }

  return summary.failed > 0 ? 1 : 0;
};

process.exitCode = await main().catch((error) => {
  console.error(`Import failed: ${redact(error)}`);
  return 1;
});
