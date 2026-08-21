import { mkdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, relative, resolve } from 'node:path';
import { getDataDir, getDatabasePath } from './config';

const repoRoot = resolve(import.meta.dir, '../../..');
const dataDir = getDataDir();
const databasePath = getDatabasePath();
const port = Number.parseInt(process.env.BUKSHELF_PORT ?? '43175', 10);
const hostname = process.env.BUKSHELF_HOST ?? '127.0.0.1';

const isListening = () =>
  new Promise<boolean>((resolveListening) => {
    const socket = createConnection({ host: hostname, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const relativeDataDir = relative(repoRoot, dataDir);
const databaseRelativeToData = relative(dataDir, databasePath);
if (
  !relativeDataDir ||
  relativeDataDir.startsWith('..') ||
  resolve(dataDir) === repoRoot ||
  !basename(dataDir).toLowerCase().includes('bukshelf')
) {
  throw new Error(
    `Refusing development reset outside a repository-local bukshelf-named directory: ${dataDir}`,
  );
}
if (databaseRelativeToData.startsWith('..')) {
  throw new Error(`Refusing development reset: database is outside the data directory`);
}
if (await isListening()) {
  throw new Error(`Port ${port} is already in use. Stop Bukshelf before running a fresh start.`);
}

await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true, mode: 0o700 });
console.log(`Reset Bukshelf development data at ${dataDir}`);
