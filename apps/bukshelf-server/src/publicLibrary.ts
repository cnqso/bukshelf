import { createHash } from 'node:crypto';
import { ObjectStoreError, type ObjectStore } from './objectStore';
import type { SyncStore } from './syncStore';

export interface PublicLibraryBook {
  id: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
}

export interface PublicCover {
  body: Uint8Array;
  contentType?: string;
}

export interface PublicLibraryService {
  listBooks(): Promise<PublicLibraryBook[]>;
  getCover(fileId: string): Promise<PublicCover | null>;
}

/** Catalog rows a PublicCatalog implementation supplies. Only metadata, never bytes. */
export interface CatalogBook {
  bookHash: string;
  title: string | null;
  sourceTitle: string | null;
  author: string | null;
  coverId: string | null;
}

export interface CatalogCoverFile {
  fileKey: string;
  bookHash: string | null;
}

export interface PublicCatalog {
  listBooks(): Promise<CatalogBook[]>;
  findCoverFile(fileId: string): Promise<CatalogCoverFile | null>;
}

const isCoverKey = (fileKey: string): boolean => /\/cover\.(png|jpe?g|webp|gif)$/i.test(fileKey);

/**
 * Generic engine: any PublicCatalog for metadata plus an ObjectStore for cover
 * bytes. createLocalPublicLibrary below is the only production caller
 * (SQLite-backed); this indirection exists so it's testable against a fake
 * catalog without a real database.
 */
export const createPublicLibrary = (
  catalog: PublicCatalog,
  store: ObjectStore,
): PublicLibraryService => ({
  async listBooks() {
    const books = await catalog.listBooks();
    return books.map((book) => ({
      id: createHash('sha256').update(book.bookHash).digest('hex').slice(0, 24),
      title: book.title?.trim() || book.sourceTitle?.trim() || 'Untitled',
      author: book.author?.trim() || null,
      coverUrl: book.coverId ? `/api/public/library/covers/${book.coverId}` : null,
    }));
  },

  async getCover(fileId) {
    const file = await catalog.findCoverFile(fileId);
    if (!file?.bookHash || !isCoverKey(file.fileKey)) return null;

    try {
      const cover = await store.readCover(file.bookHash);
      return cover ? { body: cover.body, contentType: cover.contentType } : null;
    } catch (error) {
      // A hash the store rejects is indistinguishable from a missing cover here.
      if (error instanceof ObjectStoreError) return null;
      throw error;
    }
  },
});

const coverIdFor = (bookHash: string) => {
  const hex = createHash('sha256').update(`cover:${bookHash}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Final local catalog: SQLite metadata plus filesystem cover bytes. */
export const createLocalPublicLibrary = (
  sync: SyncStore,
  store: ObjectStore,
): PublicLibraryService => ({
  async listBooks() {
    const books = sync.publicBooks();
    const result: PublicLibraryBook[] = [];
    for (const book of books) {
      const bookHash = String(book.book_hash);
      result.push({
        id: createHash('sha256').update(bookHash).digest('hex').slice(0, 24),
        title: String(book.title || book.source_title || 'Untitled').trim(),
        author: book.author ? String(book.author).trim() : null,
        coverUrl: (await store.readCover(bookHash))
          ? `/api/public/library/covers/${coverIdFor(bookHash)}`
          : null,
      });
    }
    return result;
  },

  async getCover(fileId) {
    const book = sync.publicBooks().find((row) => coverIdFor(String(row.book_hash)) === fileId);
    if (!book) return null;
    const cover = await store.readCover(String(book.book_hash));
    return cover ? { body: cover.body, contentType: cover.contentType } : null;
  },
});
