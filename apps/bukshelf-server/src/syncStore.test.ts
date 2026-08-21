import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { AuthStore } from './authStore';
import { SyncStore } from './syncStore';

const owner = '123e4567-e89b-42d3-a456-426614174000';
const book = (overrides: Record<string, unknown> = {}) => ({
  hash: 'book-a',
  metaHash: 'meta-a',
  format: 'EPUB',
  title: 'Original',
  author: 'Author',
  tags: ['one'],
  progress: [0, 100],
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

describe('SQLite classic synchronization', () => {
  let auth: AuthStore;
  let sync: SyncStore;

  beforeEach(() => {
    auth = new AuthStore(':memory:');
    sync = new SyncStore(auth.database);
  });
  afterEach(() => auth.close());

  test('round-trips a complete library slice to a second device', () => {
    sync.push(
      {
        books: [book()],
        configs: [
          { bookHash: 'book-a', progress: [12, 100], location: 'cfi-12', updatedAt: 3_000 },
        ],
        notes: [
          {
            bookHash: 'book-a',
            id: 'note-a',
            type: 'highlight',
            note: 'Important',
            createdAt: 2_500,
            updatedAt: 3_000,
          },
        ],
      },
      owner,
    );
    const pulled = sync.pull({ since: 0 });
    expect(pulled.books).toHaveLength(1);
    expect(pulled.books[0]).toMatchObject({ book_hash: 'book-a', title: 'Original' });
    expect(pulled.configs[0]).toMatchObject({ book_hash: 'book-a', location: 'cfi-12' });
    expect(pulled.notes[0]).toMatchObject({ id: 'note-a', note: 'Important' });
  });

  test('merges status, cover, and metadata on their independent clocks', () => {
    sync.import('books', {
      user_id: owner,
      book_hash: 'book-a',
      format: 'EPUB',
      title: 'Server title',
      author: 'Server author',
      tags: ['server'],
      metadata: null,
      updated_at: new Date(30_000).toISOString(),
      synced_at: new Date(30_000).toISOString(),
      reading_status: 'reading',
      reading_status_updated_at: new Date(10_000).toISOString(),
      cover_hash: 'old-cover',
      cover_updated_at: new Date(10_000).toISOString(),
      metadata_updated_at: new Date(10_000).toISOString(),
    });
    const result = sync.push(
      {
        books: [
          book({
            title: 'Client title',
            author: 'Client author',
            tags: ['client'],
            updatedAt: 20_000,
            readingStatus: 'finished',
            readingStatusUpdatedAt: 40_000,
            coverHash: 'new-cover',
            coverUpdatedAt: 40_000,
            metadataUpdatedAt: 40_000,
          }),
        ],
      },
      owner,
    );
    expect(result.books[0]).toMatchObject({
      reading_status: 'finished',
      cover_hash: 'new-cover',
      title: 'Client title',
      author: 'Client author',
      updated_at: new Date(30_000).toISOString(),
    });
  });

  test('does not churn sync cursors for newer field clocks with unchanged values', () => {
    const originalSync = new Date(30_000).toISOString();
    sync.import('books', {
      user_id: owner,
      book_hash: 'book-a',
      format: 'EPUB',
      title: 'Original',
      author: 'Author',
      tags: ['one'],
      metadata: null,
      updated_at: new Date(30_000).toISOString(),
      synced_at: originalSync,
      reading_status: 'reading',
      reading_status_updated_at: new Date(10_000).toISOString(),
      cover_hash: 'cover',
      cover_updated_at: new Date(10_000).toISOString(),
      metadata_updated_at: new Date(10_000).toISOString(),
    });

    const result = sync.push(
      {
        books: [
          book({
            updatedAt: 20_000,
            readingStatus: 'reading',
            readingStatusUpdatedAt: 40_000,
            coverHash: 'cover',
            coverUpdatedAt: 40_000,
            metadataUpdatedAt: 40_000,
          }),
        ],
      },
      owner,
    );

    expect(result.books[0]?.synced_at).toBe(originalSync);
    expect(result.books[0]?.reading_status_updated_at).toBe(new Date(10_000).toISOString());
  });

  test('propagates tombstones and keeps the longest page-duration event', () => {
    sync.push({ books: [book()] }, owner);
    sync.push({ books: [book({ updatedAt: 4_000, deletedAt: 5_000 })] }, owner);
    expect(sync.pull({ since: 0, type: 'books' }).books[0]?.deleted_at).toBeTruthy();

    const page = { book_hash: 'book-a', page: 3, start_time: 10, total_pages: 100 };
    sync.push({ statPages: [{ ...page, duration: 90 }] }, owner);
    sync.push({ statPages: [{ ...page, duration: 20 }] }, owner);
    expect(sync.pull({ since: 0, type: 'stats' }).statPages[0]?.duration).toBe(90);
  });

  test('hard-deleting the cloud library leaves notes and configs intact', () => {
    sync.push(
      {
        books: [book()],
        configs: [{ bookHash: 'book-a', updatedAt: 1_000 }],
        notes: [{ bookHash: 'book-a', id: 'n', note: '', updatedAt: 1_000 }],
      },
      owner,
    );
    sync.deleteLibrary();
    const result = sync.pull({ since: 0 });
    expect(result.books).toEqual([]);
    expect(result.configs).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
  });
});
