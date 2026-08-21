import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { FileStore, FileStoreError } from './fileStore';
import { createHandler } from './app';
import { createObjectStore } from './objectStore';

describe('authenticated filesystem storage', () => {
  let root: string;
  let authStore: AuthStore;
  let auth: AuthService;
  let files: FileStore;
  let authorization: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bukshelf-files-'));
    authStore = new AuthStore(':memory:');
    authStore.createOwner({
      id: 'owner',
      email: 'owner@example.com',
      passwordHash: await Bun.password.hash('password'),
    });
    auth = new AuthService(authStore, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
    files = new FileStore(authStore.database, root);
    authorization = `Bearer ${auth.issue(authStore.getOwner()!).accessToken}`;
  });

  afterEach(async () => {
    authStore.close();
    await rm(root, { recursive: true, force: true });
  });

  test('streams an upload and downloads the same bytes', async () => {
    const handler = createHandler({ auth, files });
    const path = 'books/abc123/book.epub';
    const upload = await handler(
      new Request(`http://localhost/api/files?path=${encodeURIComponent(path)}&bookHash=abc123`, {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/epub+zip' },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(upload.status).toBe(201);
    expect((await upload.json()).file).toMatchObject({
      file_key: path,
      file_size: 4,
      book_hash: 'abc123',
    });

    const download = await handler(
      new Request(`http://localhost/api/files?path=${encodeURIComponent(path)}`, {
        headers: { authorization },
      }),
    );
    expect(download.status).toBe(200);
    expect(await download.bytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test('lists, meters, and bulk-deletes SQLite metadata', async () => {
    const handler = createHandler({ auth, files });
    for (const path of ['replicas/font/id/font.ttf', 'replicas/font/id/license.txt']) {
      await handler(
        new Request(
          `http://localhost/api/files?path=${encodeURIComponent(path)}&replicaKind=font&replicaId=id`,
          {
            method: 'PUT',
            headers: { authorization },
            body: 'content',
          },
        ),
      );
    }
    const list = await handler(
      new Request('http://localhost/api/files?pageSize=20', { headers: { authorization } }),
    );
    expect((await list.json()).total).toBe(2);
    const stats = await handler(
      new Request('http://localhost/api/files/stats', { headers: { authorization } }),
    );
    expect(await stats.json()).toMatchObject({ totalFiles: 2, totalSize: 14 });

    const deleted = await handler(
      new Request('http://localhost/api/files', {
        method: 'DELETE',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          paths: ['replicas/font/id/font.ttf', 'replicas/font/id/license.txt'],
        }),
      }),
    );
    expect(await deleted.json()).toMatchObject({ deletedCount: 2, failedCount: 0 });
  });

  test('requires a live session and rejects traversal', async () => {
    const handler = createHandler({ auth, files });
    const unauthorized = await handler(
      new Request('http://localhost/api/files?path=books/a/book.epub'),
    );
    expect(unauthorized.status).toBe(401);
    expect(() => files.path('../escape')).toThrow(FileStoreError);
    expect(() => files.path('/absolute')).toThrow(FileStoreError);
    expect(() => files.path('books\\escape')).toThrow(FileStoreError);
  });

  test('consolidates books into the canonical store and deletes them there', async () => {
    const objects = createObjectStore({ root });
    files = new FileStore(authStore.database, root, objects);
    const handler = createHandler({ auth, files });
    const path = 'books/abc123/abc123.epub';
    const upload = await handler(
      new Request(`http://localhost/api/files?path=${encodeURIComponent(path)}&bookHash=abc123`, {
        method: 'PUT',
        headers: { authorization },
        body: new Uint8Array([9, 8, 7]),
      }),
    );
    expect(upload.status).toBe(201);
    expect((await objects.findBook('abc123'))?.path).toBe(objects.bookPath('abc123', 'epub'));
    expect(await Bun.file(files.path(path)).exists()).toBe(false);

    const deleted = await handler(
      new Request(`http://localhost/api/files?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { authorization },
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await objects.findBook('abc123')).toBeNull();
  });

  test('maps Readest client book paths onto the canonical object store', async () => {
    const objects = createObjectStore({ root });
    await objects.writeCover('abc123', 'png', new Uint8Array([1, 2, 3]));
    files = new FileStore(authStore.database, root, objects);
    const handler = createHandler({ auth, files });
    const bookPath = 'Readest/Books/abc123/abc123.epub';
    const coverPath = 'Readest/Books/abc123/cover.png';

    const upload = await handler(
      new Request(
        `http://localhost/api/files?path=${encodeURIComponent(bookPath)}&bookHash=abc123`,
        {
          method: 'PUT',
          headers: { authorization },
          body: new Uint8Array([9, 8, 7]),
        },
      ),
    );
    expect(upload.status).toBe(201);
    expect(await Bun.file(objects.bookPath('abc123', 'epub')).bytes()).toEqual(
      new Uint8Array([9, 8, 7]),
    );
    expect(await Bun.file(files.path(bookPath)).exists()).toBe(false);

    const cover = await handler(
      new Request(`http://localhost/api/files?path=${encodeURIComponent(coverPath)}`, {
        headers: { authorization },
      }),
    );
    expect(cover.status).toBe(200);
    expect(await cover.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('indexes imported canonical books and covers into SQLite on startup', async () => {
    const objects = createObjectStore({ root });
    await objects.writeBook('imported', 'epub', new Uint8Array([1, 2, 3]));
    await objects.writeCover('imported', 'jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));
    files = new FileStore(authStore.database, root, objects);
    await files.init();

    expect(files.stats()).toMatchObject({ totalFiles: 2, totalSize: 7 });
    expect(
      files.list({ page: 1, pageSize: 20, sortBy: 'file_key', sortOrder: 'asc' }).files,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file_key: 'books/imported/imported.epub' }),
        expect.objectContaining({ file_key: 'books/imported/cover.png' }),
      ]),
    );
  });
});
