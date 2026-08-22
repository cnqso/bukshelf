import { resolve } from 'node:path';

export const getDataDir = () =>
  resolve(process.env.BUKSHELF_DATA_DIR ?? resolve(import.meta.dir, '../../../data'));

export const getDatabasePath = () =>
  resolve(process.env.BUKSHELF_DATABASE_PATH ?? resolve(getDataDir(), 'bukshelf.sqlite'));
