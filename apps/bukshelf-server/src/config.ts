import { resolve } from 'node:path';

export const getDataDir = () =>
  resolve(process.env.BUKSHELF_DATA_DIR ?? resolve(import.meta.dir, '../../../data'));

export const getDatabasePath = () =>
  resolve(process.env.BUKSHELF_DATABASE_PATH ?? resolve(getDataDir(), 'bukshelf.sqlite'));

export const getLegacyDatabaseUrl = () =>
  process.env.BUKSHELF_DATABASE_URL ??
  `postgres://postgres:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? '43176'}/${encodeURIComponent(process.env.POSTGRES_DB ?? 'postgres')}`;
