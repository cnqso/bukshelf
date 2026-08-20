import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectConflictError, ObjectStoreError, createObjectStore } from './objectStore';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const HASH = 'bc5f8ebad04f324cd3d6546da6099be8';

describe('filesystem object store', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bukshelf-store-'));
    outside = await mkdtemp(join(tmpdir(), 'bukshelf-outside-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test('uses deterministic hash-keyed paths', () => {
    const store = createObjectStore({ root });
    expect(store.bookPath(HASH, 'EPUB')).toBe(join(root, 'books', HASH, 'book.epub'));
    expect(store.coverPath(HASH, 'JPG')).toBe(join(root, 'covers', HASH, 'cover.jpg'));
  });

  test('creates the data layout on init', async () => {
    const store = createObjectStore({ root });
    await store.init();
    expect((await readdir(root)).sort()).toEqual(['books', 'covers', 'tmp']);
  });

  test('writes and reads covers with the type implied by the stored extension', async () => {
    const store = createObjectStore({ root });
    expect(await store.readCover(HASH)).toBeNull();

    const written = await store.writeCover(HASH, 'jpg', JPEG);
    expect(written.status).toBe('written');

    const cover = await store.readCover(HASH);
    expect(cover?.contentType).toBe('image/jpeg');
    expect(cover?.body).toEqual(JPEG);
  });

  test('finds a stored book by its hash', async () => {
    const store = createObjectStore({ root });
    await store.writeBook(HASH, 'epub', new Uint8Array([1, 2, 3]));
    expect(await store.findBook(HASH)).toMatchObject({ format: 'epub' });
    expect(await store.findBook('deadbeef')).toBeNull();
  });

  test('skips byte-identical rewrites and refuses conflicting ones', async () => {
    const store = createObjectStore({ root });
    await store.writeCover(HASH, 'jpg', JPEG);

    expect(await store.writeCover(HASH, 'jpg', JPEG)).toMatchObject({ status: 'skipped' });
    await expect(store.writeCover(HASH, 'jpg', PNG)).rejects.toBeInstanceOf(ObjectConflictError);
    expect((await store.readCover(HASH))?.body).toEqual(JPEG);

    const forced = await store.writeCover(HASH, 'jpg', PNG, { overwrite: true });
    expect(forced.status).toBe('overwritten');
    expect((await store.readCover(HASH))?.body).toEqual(PNG);
  });

  test('leaves no partial files behind after a write', async () => {
    const store = createObjectStore({ root });
    await store.writeBook(HASH, 'pdf', new Uint8Array([9, 9, 9]));
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
  });

  test('rejects traversal, absolute paths, and unsupported formats', async () => {
    const store = createObjectStore({ root });
    for (const hash of ['../escape', '..', 'a/b', '/etc/passwd', '', 'has.dot']) {
      expect(() => store.coverPath(hash, 'jpg')).toThrow(ObjectStoreError);
    }
    expect(() => store.coverPath(HASH, 'svg')).toThrow(ObjectStoreError);
    expect(() => store.coverPath(HASH, '../../etc/passwd')).toThrow(ObjectStoreError);
    expect(() => store.bookPath(HASH, 'exe')).toThrow(ObjectStoreError);
  });

  test('refuses to follow a symlink that escapes the data root', async () => {
    const store = createObjectStore({ root });
    await store.init();
    await writeFile(join(outside, 'secret.jpg'), 'not yours');
    await symlink(outside, join(root, 'covers', HASH));

    await expect(store.writeCover(HASH, 'jpg', JPEG)).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(store.readCover(HASH)).rejects.toBeInstanceOf(ObjectStoreError);
  });
});
