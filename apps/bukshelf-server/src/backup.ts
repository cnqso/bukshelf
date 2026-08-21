import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const BACKUP_VERSION = 1;
const DATABASE_NAME = 'bukshelf.sqlite';
const MANIFEST_NAME = 'manifest.json';
const MANAGED_ROOTS = ['books', 'covers', 'files'] as const;

export interface BackupFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  files: BackupFile[];
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const exists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const isWithin = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const assertLayout = (dataDir: string, databasePath: string) => {
  for (const managedRoot of MANAGED_ROOTS) {
    if (isWithin(join(dataDir, managedRoot), databasePath))
      throw new BackupError(`Database cannot be inside the ${managedRoot} directory`);
  }
};

const sha256 = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const assertRegularFile = async (path: string) => {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new BackupError(`Refusing to back up symlink: ${path}`);
  if (!info.isFile()) throw new BackupError(`Refusing to back up non-file: ${path}`);
  return info;
};

const listFiles = async (root: string): Promise<string[]> => {
  if (!(await exists(root))) return [];
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new BackupError(`Refusing to back up symlink: ${root}`);
  if (!rootInfo.isDirectory()) throw new BackupError(`Managed path is not a directory: ${root}`);

  const result: string[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new BackupError(`Refusing to back up symlink: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
      else throw new BackupError(`Refusing to back up special file: ${path}`);
    }
  };
  await visit(root);
  return result;
};

const safeBackupPath = (root: string, relativePath: string) => {
  const segments = relativePath.split('/');
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new BackupError(`Invalid backup path: ${relativePath}`);
  const target = resolve(root, relativePath);
  const child = relative(root, target);
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new BackupError(`Backup path escapes snapshot: ${relativePath}`);
  return target;
};

const assertNoSymlinkPath = async (root: string, relativePath: string) => {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new BackupError(`Backup root is a symlink: ${root}`);
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new BackupError(`Backup path contains a symlink: ${relativePath}`);
  }
};

const sqliteString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const snapshotDatabase = async (source: string, destination: string) => {
  await assertRegularFile(source);
  const database = new Database(source, { readonly: true, strict: true });
  try {
    database.exec(`VACUUM INTO ${sqliteString(destination)}`);
  } finally {
    database.close();
  }
  await chmod(destination, 0o600);
};

const describeFile = async (root: string, path: string): Promise<BackupFile> => {
  const info = await assertRegularFile(path);
  return {
    path: relative(root, path).split('\\').join('/'),
    size: info.size,
    sha256: await sha256(path),
  };
};

export const defaultBackupDestination = (dataDir: string, now = new Date()) =>
  join(
    dataDir,
    'backups',
    now
      .toISOString()
      .replaceAll(':', '-')
      .replace(/\.\d{3}Z$/, 'Z'),
  );

export const createBackup = async (options: {
  dataDir: string;
  databasePath: string;
  destination?: string;
}): Promise<BackupResult> => {
  const dataDir = resolve(options.dataDir);
  const databasePath = resolve(options.databasePath);
  const destination = resolve(options.destination ?? defaultBackupDestination(dataDir));
  assertLayout(dataDir, databasePath);
  for (const managedRoot of MANAGED_ROOTS) {
    if (isWithin(join(dataDir, managedRoot), destination))
      throw new BackupError(`Backup destination cannot be inside the ${managedRoot} directory`);
  }
  if (await exists(destination)) throw new BackupError(`Backup already exists: ${destination}`);

  const partial = join(dirname(destination), `.${basename(destination)}.partial-${randomUUID()}`);
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    await snapshotDatabase(databasePath, join(partial, DATABASE_NAME));
    for (const managedRoot of MANAGED_ROOTS) {
      const sourceRoot = join(dataDir, managedRoot);
      const destinationRoot = join(partial, managedRoot);
      await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
      for (const source of await listFiles(sourceRoot)) {
        const target = join(destinationRoot, relative(sourceRoot, source));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(source, target);
      }
    }

    const snapshotFiles = [
      join(partial, DATABASE_NAME),
      ...(await Promise.all(MANAGED_ROOTS.map((root) => listFiles(join(partial, root))))).flat(),
    ];
    const manifest: BackupManifest = {
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      files: [],
    };
    for (const path of snapshotFiles) manifest.files.push(await describeFile(partial, path));
    await writeFile(join(partial, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(partial, destination);
    return { path: destination, manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
};

const parseManifest = (value: unknown): BackupManifest => {
  const manifest = value as Partial<BackupManifest>;
  if (manifest.version !== BACKUP_VERSION || typeof manifest.createdAt !== 'string')
    throw new BackupError('Unsupported or malformed backup manifest');
  if (!Array.isArray(manifest.files)) throw new BackupError('Malformed backup file list');
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new BackupError('Malformed backup file entry');
    if (
      file.path !== DATABASE_NAME &&
      !MANAGED_ROOTS.some((root) => file.path.startsWith(`${root}/`))
    )
      throw new BackupError(`Unsupported backup path: ${file.path}`);
  }
  if (!manifest.files.some((file) => file.path === DATABASE_NAME))
    throw new BackupError('Backup does not contain bukshelf.sqlite');
  return manifest as BackupManifest;
};

export const verifyBackup = async (backupPath: string): Promise<BackupManifest> => {
  const root = resolve(backupPath);
  let manifest: BackupManifest;
  try {
    manifest = parseManifest(JSON.parse(await readFile(join(root, MANIFEST_NAME), 'utf8')));
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(`Cannot read backup manifest: ${(error as Error).message}`);
  }

  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new BackupError(`Duplicate backup path: ${file.path}`);
    seen.add(file.path);
    const path = safeBackupPath(root, file.path);
    let info;
    try {
      await assertNoSymlinkPath(root, file.path);
      info = await assertRegularFile(path);
    } catch (error) {
      throw new BackupError(
        `Backup file missing or invalid: ${file.path}: ${(error as Error).message}`,
      );
    }
    if (info.size !== file.size) throw new BackupError(`Backup size mismatch: ${file.path}`);
    if ((await sha256(path)) !== file.sha256)
      throw new BackupError(`Backup checksum mismatch: ${file.path}`);
  }
  return manifest;
};

export const restoreBackup = async (options: {
  dataDir: string;
  databasePath: string;
  backupPath: string;
}): Promise<BackupManifest> => {
  const dataDir = resolve(options.dataDir);
  const databasePath = resolve(options.databasePath);
  const backupPath = resolve(options.backupPath);
  assertLayout(dataDir, databasePath);
  const manifest = await verifyBackup(backupPath);
  const operationId = randomUUID();
  const stageRoot = join(dataDir, 'tmp', `restore-${operationId}`);
  const rollbackRoot = join(dataDir, 'tmp', `restore-rollback-${operationId}`);
  const stagedDatabase = join(dirname(databasePath), `.bukshelf-restore-${operationId}.sqlite`);
  const rollbackDatabase = join(dirname(databasePath), `.bukshelf-rollback-${operationId}.sqlite`);
  const movedRoots: string[] = [];
  const installedRoots: string[] = [];
  let movedDatabase = false;
  let installedDatabase = false;
  const movedSidecars: string[] = [];

  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  await mkdir(rollbackRoot, { recursive: true, mode: 0o700 });
  try {
    for (const managedRoot of MANAGED_ROOTS)
      await mkdir(join(stageRoot, managedRoot), { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      const source = safeBackupPath(backupPath, file.path);
      if (file.path === DATABASE_NAME) {
        await copyFile(source, stagedDatabase);
        await chmod(stagedDatabase, 0o600);
        continue;
      }
      const root = file.path.split('/', 1)[0];
      if (!(MANAGED_ROOTS as readonly string[]).includes(root))
        throw new BackupError(`Unsupported restore path: ${file.path}`);
      const target = safeBackupPath(stageRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
    }

    for (const managedRoot of MANAGED_ROOTS) {
      const current = join(dataDir, managedRoot);
      if (await exists(current)) {
        await rename(current, join(rollbackRoot, managedRoot));
        movedRoots.push(managedRoot);
      }
      await rename(join(stageRoot, managedRoot), current);
      installedRoots.push(managedRoot);
    }

    if (await exists(databasePath)) {
      await rename(databasePath, rollbackDatabase);
      movedDatabase = true;
    }
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(`${databasePath}${suffix}`)) {
        await rename(`${databasePath}${suffix}`, `${rollbackDatabase}${suffix}`);
        movedSidecars.push(suffix);
      }
    }
    await rename(stagedDatabase, databasePath);
    installedDatabase = true;
    await rm(rollbackRoot, { recursive: true, force: true });
    if (movedDatabase) await rm(rollbackDatabase, { force: true });
    for (const suffix of movedSidecars) await rm(`${rollbackDatabase}${suffix}`, { force: true });
    return manifest;
  } catch (error) {
    if (installedDatabase) await rm(databasePath, { force: true });
    if (movedDatabase && (await exists(rollbackDatabase)))
      await rename(rollbackDatabase, databasePath);
    for (const suffix of movedSidecars) {
      if (await exists(`${rollbackDatabase}${suffix}`))
        await rename(`${rollbackDatabase}${suffix}`, `${databasePath}${suffix}`);
    }
    for (const managedRoot of [...installedRoots].reverse()) {
      const current = join(dataDir, managedRoot);
      const previous = join(rollbackRoot, managedRoot);
      if (await exists(current)) await rm(current, { recursive: true, force: true });
      if (movedRoots.includes(managedRoot) && (await exists(previous)))
        await rename(previous, current);
    }
    for (const managedRoot of movedRoots
      .filter((root) => !installedRoots.includes(root))
      .reverse()) {
      const previous = join(rollbackRoot, managedRoot);
      if (await exists(previous)) await rename(previous, join(dataDir, managedRoot));
    }
    await rm(rollbackRoot, { recursive: true, force: true });
    await rm(rollbackDatabase, { force: true });
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
    await rm(stagedDatabase, { force: true });
  }
};
