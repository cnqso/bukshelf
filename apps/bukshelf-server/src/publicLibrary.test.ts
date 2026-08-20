import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectStore } from './objectStore';
import { type PublicCatalog, createPublicLibrary } from './publicLibrary';

const HASH = 'bc5f8ebad04f324cd3d6546da6099be8';
const COVER_ID = '540885a5-3542-483f-9700-1952d873a3c3';
const COVER_KEY = `2648b8e8-5b89-47ac-a207-f3322eb43ae0/Readest/Books/${HASH}/cover.png`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x77]);

const catalog: PublicCatalog = {
  async listBooks() {
    return [
      {
        bookHash: HASH,
        title: '  The Search for Modern China  ',
        sourceTitle: null,
        author: '  Jonathan D. Spence  ',
        coverId: COVER_ID,
      },
      { bookHash: 'untitled', title: '   ', sourceTitle: null, author: '', coverId: null },
    ];
  },
  async findCoverFile(fileId) {
    if (fileId === COVER_ID) return { fileKey: COVER_KEY, bookHash: HASH };
    if (fileId === 'book-file') return { fileKey: `books/${HASH}/${HASH}.epub`, bookHash: HASH };
    if (fileId === 'bad-hash') return { fileKey: COVER_KEY, bookHash: '../../../etc' };
    return null;
  },
};

describe('public library', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bukshelf-public-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('exposes only opaque ids, titles, authors, and cover urls', async () => {
    const store = createObjectStore({ root });
    const books = await createPublicLibrary(catalog, store).listBooks();

    expect(books[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      title: 'The Search for Modern China',
      author: 'Jonathan D. Spence',
      coverUrl: `/api/public/library/covers/${COVER_ID}`,
    });
    expect(books[0]?.id).not.toContain(HASH);
    expect(books[1]).toMatchObject({ title: 'Untitled', author: null, coverUrl: null });
  });

  test('serves cover bytes from the data directory, not from object storage', async () => {
    const store = createObjectStore({ root });
    const library = createPublicLibrary(catalog, store);

    expect(await library.getCover(COVER_ID)).toBeNull();

    await store.writeCover(HASH, 'jpg', JPEG);
    expect(await library.getCover(COVER_ID)).toEqual({ body: JPEG, contentType: 'image/jpeg' });
  });

  test('refuses non-cover files, unknown ids, and hashes the store rejects', async () => {
    const store = createObjectStore({ root });
    await store.writeCover(HASH, 'jpg', JPEG);
    const library = createPublicLibrary(catalog, store);

    expect(await library.getCover('book-file')).toBeNull();
    expect(await library.getCover('bad-hash')).toBeNull();
    expect(await library.getCover('nope')).toBeNull();
  });
});
