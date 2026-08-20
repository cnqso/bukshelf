import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { COVER_EXTENSIONS, type CoverExtension, coverContentType } from './imageType';

/**
 * The on-disk layout Bukshelf owns:
 *
 *   $BUKSHELF_DATA_DIR/
 *   ├── books/<book-hash>/book.<format>
 *   ├── covers/<book-hash>/cover.<image-extension>
 *   └── tmp/
 *
 * Paths depend only on the book hash, never on the legacy user UUID or the
 * legacy object key, so the store survives the rest of the migration.
 */

export const BOOK_FORMATS = ['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz', 'txt'] as const;

export type BookFormat = (typeof BOOK_FORMATS)[number];

/** Deliberately excludes `.` and `/`, so a hash can never traverse or absolutize. */
const BOOK_HASH = /^[A-Za-z0-9_-]{1,128}$/;

export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreError';
  }
}

export class ObjectConflictError extends ObjectStoreError {
  constructor(public readonly path: string) {
    super(`Refusing to replace an existing object with different bytes: ${path}`);
    this.name = 'ObjectConflictError';
  }
}

export type WriteStatus = 'written' | 'skipped' | 'overwritten';

export interface WriteResult {
  status: WriteStatus;
  path: string;
}

export interface StoredCover {
  body: Uint8Array;
  contentType: string;
  path: string;
}

export interface StoredBook {
  path: string;
  format: BookFormat;
}

export interface WriteOptions {
  overwrite?: boolean;
}

export interface ObjectStore {
  readonly root: string;
  init(): Promise<void>;
  bookPath(bookHash: string, format: string): string;
  coverPath(bookHash: string, extension: string): string;
  findBook(bookHash: string): Promise<StoredBook | null>;
  readCover(bookHash: string): Promise<StoredCover | null>;
  writeBook(
    bookHash: string,
    format: string,
    body: Uint8Array,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  writeCover(
    bookHash: string,
    extension: string,
    body: Uint8Array,
    options?: WriteOptions,
  ): Promise<WriteResult>;
}

export const isBookFormat = (value: string): value is BookFormat =>
  (BOOK_FORMATS as readonly string[]).includes(value);

export const isCoverExtension = (value: string): value is CoverExtension =>
  (COVER_EXTENSIONS as readonly string[]).includes(value);

const assertBookHash = (bookHash: string): string => {
  if (!BOOK_HASH.test(bookHash)) throw new ObjectStoreError(`Invalid book hash: ${bookHash}`);
  return bookHash;
};

const assertBookFormat = (format: string): BookFormat => {
  const normalized = format.toLowerCase();
  if (!isBookFormat(normalized)) throw new ObjectStoreError(`Unsupported book format: ${format}`);
  return normalized;
};

const assertCoverExtension = (extension: string): CoverExtension => {
  const normalized = extension.toLowerCase();
  if (!isCoverExtension(normalized))
    throw new ObjectStoreError(`Unsupported cover format: ${extension}`);
  return normalized;
};

const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export const createObjectStore = (options: { root: string }): ObjectStore => {
  const root = resolve(options.root);

  /**
   * Resolves the nearest existing ancestor of `target` and fails if it lands
   * outside the data root. This catches a symlinked `covers/<hash>` directory
   * (or a symlinked object) pointing anywhere else on the host.
   */
  const realRootPath = async (): Promise<string> => {
    try {
      return await realpath(root);
    } catch (error) {
      if (isMissing(error)) return root;
      throw error;
    }
  };

  const assertInsideRoot = async (target: string): Promise<void> => {
    const realRoot = await realRootPath();
    let current = target;

    for (;;) {
      let real: string | undefined;
      try {
        real = await realpath(current);
      } catch (error) {
        if (!isMissing(error)) throw error;
        const parent = dirname(current);
        if (parent === current) throw new ObjectStoreError(`Path escapes the data root: ${target}`);
        current = parent;
        continue;
      }

      const child = relative(realRoot, real);
      if (child !== '' && (child.startsWith('..') || isAbsolute(child)))
        throw new ObjectStoreError(`Path escapes the data root: ${target}`);
      return;
    }
  };

  const assertNotSymlink = async (target: string): Promise<boolean> => {
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink())
        throw new ObjectStoreError(`Refusing to write through a symlink: ${target}`);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  };

  const bookPath = (bookHash: string, format: string) =>
    join(root, 'books', assertBookHash(bookHash), `book.${assertBookFormat(format)}`);

  const coverPath = (bookHash: string, extension: string) =>
    join(root, 'covers', assertBookHash(bookHash), `cover.${assertCoverExtension(extension)}`);

  const init = async () => {
    for (const directory of ['books', 'covers', 'tmp'])
      await mkdir(join(root, directory), { recursive: true });
  };

  /** Temp file in `$root/tmp` followed by a rename, so readers never see a partial object. */
  const write = async (
    target: string,
    body: Uint8Array,
    { overwrite = false }: WriteOptions,
  ): Promise<WriteResult> => {
    await assertInsideRoot(target);

    const exists = await assertNotSymlink(target);
    if (exists) {
      const current = await Bun.file(target).bytes();
      if (digest(current) === digest(body)) return { status: 'skipped', path: target };
      if (!overwrite) throw new ObjectConflictError(target);
    }

    await init();
    await mkdir(dirname(target), { recursive: true });
    await assertInsideRoot(target);

    const temporary = join(root, 'tmp', `${randomBytes(16).toString('hex')}.part`);
    try {
      await Bun.write(temporary, body);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }

    return { status: exists ? 'overwritten' : 'written', path: target };
  };

  return {
    root,
    init,
    bookPath,
    coverPath,

    async findBook(bookHash) {
      for (const format of BOOK_FORMATS) {
        const path = bookPath(bookHash, format);
        await assertInsideRoot(path);
        if (await Bun.file(path).exists()) return { path, format };
      }
      return null;
    },

    async readCover(bookHash) {
      for (const extension of COVER_EXTENSIONS) {
        const path = coverPath(bookHash, extension);
        await assertInsideRoot(path);
        const file = Bun.file(path);
        if (!(await file.exists())) continue;
        return { body: await file.bytes(), contentType: coverContentType(extension)!, path };
      }
      return null;
    },

    writeBook: (bookHash, format, body, writeOptions = {}) =>
      write(bookPath(bookHash, format), body, writeOptions),

    writeCover: (bookHash, extension, body, writeOptions = {}) =>
      write(coverPath(bookHash, extension), body, writeOptions),
  };
};
