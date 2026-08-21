import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from './authStore';
import { createBackup, restoreBackup, verifyBackup } from './backup';

describe('Bukshelf backups', () => {
  let root: string;
  let dataDir: string;
  let databasePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bukshelf-backup-'));
    dataDir = join(root, 'data');
    databasePath = join(dataDir, 'bukshelf.sqlite');
    await mkdir(join(dataDir, 'books', 'book-one'), { recursive: true });
    await mkdir(join(dataDir, 'covers', 'book-one'), { recursive: true });
    await mkdir(join(dataDir, 'files', 'replicas'), { recursive: true });
    await writeFile(join(dataDir, 'books', 'book-one', 'book.epub'), 'book bytes');
    await writeFile(join(dataDir, 'covers', 'book-one', 'cover.jpg'), 'cover bytes');
    await writeFile(join(dataDir, 'files', 'replicas', 'settings.bin'), 'replica bytes');

    const store = new AuthStore(databasePath);
    store.createOwner({ id: 'owner-1', email: 'owner@example.com', passwordHash: 'hash' });
    store.database.exec(
      "CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('before');",
    );
    store.close();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('creates and verifies a portable snapshot', async () => {
    const destination = join(root, 'snapshots', 'first');
    const result = await createBackup({ dataDir, databasePath, destination });

    expect(result.path).toBe(destination);
    expect(result.manifest.files.map((file) => file.path)).toEqual([
      'bukshelf.sqlite',
      'books/book-one/book.epub',
      'covers/book-one/cover.jpg',
      'files/replicas/settings.bin',
    ]);
    await expect(verifyBackup(destination)).resolves.toEqual(result.manifest);

    const snapshot = new AuthStore(join(destination, 'bukshelf.sqlite'));
    expect(snapshot.getOwner()?.email).toBe('owner@example.com');
    expect(
      snapshot.database.query<{ value: string }, []>('SELECT value FROM sample').get()?.value,
    ).toBe('before');
    snapshot.close();
  });

  test('detects changed snapshot bytes before restore', async () => {
    const destination = join(root, 'snapshots', 'first');
    await createBackup({ dataDir, databasePath, destination });
    await writeFile(join(destination, 'books', 'book-one', 'book.epub'), 'evil bytes');

    await expect(verifyBackup(destination)).rejects.toThrow('checksum mismatch');
  });

  test('refuses to replace an existing backup', async () => {
    const destination = join(root, 'snapshots', 'first');
    await createBackup({ dataDir, databasePath, destination });

    await expect(createBackup({ dataDir, databasePath, destination })).rejects.toThrow(
      'already exists',
    );
  });

  test('refuses to place a recursively growing snapshot inside managed storage', async () => {
    await expect(
      createBackup({
        dataDir,
        databasePath,
        destination: join(dataDir, 'books', 'not-a-backup-location'),
      }),
    ).rejects.toThrow('cannot be inside the books directory');
  });

  test('restores the database and every managed file tree', async () => {
    const destination = join(root, 'snapshots', 'first');
    await createBackup({ dataDir, databasePath, destination });

    const changed = new AuthStore(databasePath);
    changed.database.exec("UPDATE sample SET value = 'after'");
    changed.close();
    await writeFile(join(dataDir, 'books', 'book-one', 'book.epub'), 'changed book');
    await writeFile(join(dataDir, 'files', 'new.bin'), 'not in backup');
    await rm(join(dataDir, 'covers'), { recursive: true });

    await restoreBackup({ dataDir, databasePath, backupPath: destination });

    const restored = new AuthStore(databasePath);
    expect(
      restored.database.query<{ value: string }, []>('SELECT value FROM sample').get()?.value,
    ).toBe('before');
    restored.close();
    expect(await readFile(join(dataDir, 'books', 'book-one', 'book.epub'), 'utf8')).toBe(
      'book bytes',
    );
    expect(await readFile(join(dataDir, 'covers', 'book-one', 'cover.jpg'), 'utf8')).toBe(
      'cover bytes',
    );
    expect(await Bun.file(join(dataDir, 'files', 'new.bin')).exists()).toBe(false);
  });

  test('rejects symlinks instead of copying files outside the managed trees', async () => {
    await Bun.$`ln -s ${join(root, 'outside')} ${join(dataDir, 'files', 'escape')}`.quiet();

    await expect(
      createBackup({ dataDir, databasePath, destination: join(root, 'snapshots', 'first') }),
    ).rejects.toThrow('symlink');
  });
});
