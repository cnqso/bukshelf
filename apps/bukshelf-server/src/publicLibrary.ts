import { createHash } from 'node:crypto';
import { SQL } from 'bun';
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

/** Catalog rows the legacy Postgres still supplies. Only metadata, never bytes. */
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

interface LegacyLibraryConfig {
  databaseUrl: string;
  ownerEmail: string;
  /** Cover bytes come from here; MinIO is no longer on the serving path. */
  store: ObjectStore;
}

const isCoverKey = (fileKey: string): boolean => /\/cover\.(png|jpe?g|webp|gif)$/i.test(fileKey);

/**
 * Postgres is still the temporary source of catalog metadata and of the opaque
 * cover-id lookup. Cover bytes are served from the imported data directory, so
 * the public shelf keeps working with MinIO stopped or misconfigured.
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

export const createLegacyCatalog = (config: LegacyLibraryConfig): PublicCatalog => {
  const database = new SQL(config.databaseUrl);

  const findOwnerId = async (): Promise<string | null> => {
    const rows = await database`
      SELECT id
      FROM auth.users
      WHERE lower(email) = lower(${config.ownerEmail})
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  };

  return {
    async listBooks() {
      const ownerId = await findOwnerId();
      if (!ownerId) return [];

      const rows = await database`
        SELECT
          b.book_hash,
          b.title,
          b.source_title,
          b.author,
          f.id AS cover_id
        FROM public.books b
        LEFT JOIN LATERAL (
          SELECT id
          FROM public.files
          WHERE user_id = b.user_id
            AND book_hash = b.book_hash
            AND deleted_at IS NULL
            AND file_key ~* '/cover\\.(png|jpe?g|webp|gif)$'
          ORDER BY updated_at DESC
          LIMIT 1
        ) f ON true
        WHERE b.user_id = ${ownerId}
          AND b.deleted_at IS NULL
        ORDER BY b.updated_at DESC
      `;

      return rows.map(
        (book: {
          book_hash: string;
          title: string | null;
          source_title: string | null;
          author: string | null;
          cover_id: string | null;
        }) => ({
          bookHash: book.book_hash,
          title: book.title,
          sourceTitle: book.source_title,
          author: book.author,
          coverId: book.cover_id,
        }),
      );
    },

    async findCoverFile(fileId) {
      const ownerId = await findOwnerId();
      if (!ownerId) return null;

      const rows = await database`
        SELECT f.file_key, f.book_hash
        FROM public.files f
        INNER JOIN public.books b
          ON b.user_id = f.user_id
          AND b.book_hash = f.book_hash
          AND b.deleted_at IS NULL
        WHERE f.id = ${fileId}
          AND f.user_id = ${ownerId}
          AND f.deleted_at IS NULL
        LIMIT 1
      `;

      const row = rows[0];
      return row ? { fileKey: row.file_key, bookHash: row.book_hash } : null;
    },
  };
};

export const createLegacyPublicLibrary = (config: LegacyLibraryConfig): PublicLibraryService =>
  createPublicLibrary(createLegacyCatalog(config), config.store);

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
