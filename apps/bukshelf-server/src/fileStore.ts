import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { isBookFormat, isCoverExtension, type ObjectStore } from './objectStore';

export interface StoredFileRecord {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind: string | null;
  replica_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface FileListOptions {
  page: number;
  pageSize: number;
  sortBy: 'created_at' | 'updated_at' | 'file_size' | 'file_key';
  sortOrder: 'asc' | 'desc';
  bookHash?: string;
  search?: string;
}

const FILE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]{1,1024}$/;

export class FileStoreError extends Error {}

export class FileStore {
  readonly dataRoot: string;
  readonly filesRoot: string;
  readonly temporaryRoot: string;

  constructor(
    private readonly database: Database,
    dataRoot: string,
    private readonly legacyObjects?: ObjectStore,
  ) {
    this.dataRoot = resolve(dataRoot);
    this.filesRoot = resolve(this.dataRoot, 'files');
    this.temporaryRoot = resolve(this.dataRoot, 'tmp');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS storage_files (
        file_key TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL CHECK (file_size >= 0),
        book_hash TEXT,
        replica_kind TEXT,
        replica_id TEXT,
        content_type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS storage_files_book_hash ON storage_files (book_hash);
      CREATE INDEX IF NOT EXISTS storage_files_replica ON storage_files (replica_kind, replica_id);
    `);
  }

  validateKey(fileKey: string): string {
    if (!FILE_KEY.test(fileKey)) throw new FileStoreError('Invalid file path');
    const target = resolve(this.filesRoot, fileKey);
    const child = relative(this.filesRoot, target);
    if (!child || child.startsWith('..') || isAbsolute(child))
      throw new FileStoreError('Invalid file path');
    return fileKey;
  }

  path(fileKey: string): string {
    return resolve(this.filesRoot, this.validateKey(fileKey));
  }

  async init(): Promise<void> {
    await mkdir(this.filesRoot, { recursive: true });
    await mkdir(this.temporaryRoot, { recursive: true });
    if (!this.legacyObjects) return;

    for (const kind of ['books', 'covers'] as const) {
      const root = resolve(this.dataRoot, kind);
      const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const bookHash = directory.name;
        const entries = await readdir(resolve(root, bookHash), { withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const physicalPath = resolve(root, bookHash, entry.name);
          await this.assertNoSymlink(physicalPath);
          const info = await stat(physicalPath);
          const extension = extname(entry.name).slice(1).toLowerCase();
          const fileKey =
            kind === 'covers'
              ? `books/${bookHash}/cover.png`
              : `books/${bookHash}/${bookHash}.${extension}`;
          this.insertExisting(fileKey, info.size, bookHash, contentTypeFor(physicalPath));
        }
      }
    }
  }

  async write(
    fileKey: string,
    body: ReadableStream<Uint8Array> | null,
    metadata: {
      bookHash?: string;
      replicaKind?: string;
      replicaId?: string;
      contentType?: string;
    } = {},
  ): Promise<StoredFileRecord> {
    if (!body) throw new FileStoreError('File body is required');
    const genericTarget = this.path(fileKey);
    const target = this.canonicalTarget(fileKey, metadata.bookHash) ?? genericTarget;
    await mkdir(this.temporaryRoot, { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    await this.assertNoSymlink(target);
    const temporary = join(this.temporaryRoot, `${randomBytes(16).toString('hex')}.part`);
    try {
      const sink = Bun.file(temporary).writer();
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sink.write(value);
        }
        await sink.end();
      } catch (error) {
        await sink.end(error instanceof Error ? error : new Error('Upload failed'));
        throw error;
      }
      const size = Bun.file(temporary).size;
      let previousPath: string | undefined;
      if (target !== genericTarget && this.legacyObjects) {
        const name = fileKey.split('/').at(-1)!.toLowerCase();
        const previous = name.startsWith('cover.')
          ? await this.legacyObjects.readCover(metadata.bookHash!)
          : await this.legacyObjects.findBook(metadata.bookHash!);
        if (previous?.path && previous.path !== target) previousPath = previous.path;
      }
      await rename(temporary, target);
      if (previousPath) await unlink(previousPath);
      const now = Date.now();
      this.database
        .query(
          `INSERT INTO storage_files
             (file_key, file_size, book_hash, replica_kind, replica_id, content_type, created_at, updated_at)
           VALUES ($fileKey, $size, $bookHash, $replicaKind, $replicaId, $contentType, $now, $now)
           ON CONFLICT(file_key) DO UPDATE SET
             file_size = excluded.file_size,
             book_hash = excluded.book_hash,
             replica_kind = excluded.replica_kind,
             replica_id = excluded.replica_id,
             content_type = excluded.content_type,
             updated_at = excluded.updated_at`,
        )
        .run({
          fileKey,
          size,
          bookHash: metadata.bookHash ?? null,
          replicaKind: metadata.replicaKind ?? null,
          replicaId: metadata.replicaId ?? null,
          contentType: metadata.contentType ?? null,
          now,
        });
      return this.getRecord(fileKey)!;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async read(
    fileKey: string,
  ): Promise<{ file: ReturnType<typeof Bun.file>; contentType?: string } | null> {
    const target = this.path(fileKey);
    await this.assertNoSymlink(target);
    const file = Bun.file(target);
    if (await file.exists()) {
      const row = this.database
        .query<{ content_type: string | null }, string>(
          'SELECT content_type FROM storage_files WHERE file_key = ?',
        )
        .get(fileKey);
      return { file, contentType: row?.content_type ?? undefined };
    }

    // Imported Readest objects already use the final hash-keyed layout. This
    // read-only bridge avoids copying them into the new generic file tree.
    return this.readLegacy(fileKey);
  }

  async delete(fileKey: string): Promise<boolean> {
    const target = this.path(fileKey);
    await this.assertNoSymlink(target);
    let storedTarget: string | undefined = (await Bun.file(target).exists()) ? target : undefined;
    if (!storedTarget) {
      const legacy = await this.readLegacy(fileKey);
      storedTarget = legacy?.file.name;
    }
    if (storedTarget) {
      await this.assertNoSymlink(storedTarget);
      await unlink(storedTarget);
    }
    this.database.query('DELETE FROM storage_files WHERE file_key = ?').run(fileKey);
    return Boolean(storedTarget);
  }

  list(options: FileListOptions) {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (options.bookHash) {
      where.push('book_hash = $bookHash');
      params.bookHash = options.bookHash;
    }
    if (options.search) {
      where.push("file_key LIKE $search ESCAPE '\\'");
      params.search = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
    }
    const predicate = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.database
        .query<{ count: number }, Record<string, string | number>>(
          `SELECT COUNT(*) AS count FROM storage_files ${predicate}`,
        )
        .get(params)?.count ?? 0;
    const offset = (options.page - 1) * options.pageSize;
    const rows = this.database
      .query<Record<string, string | number | null>, Record<string, string | number>>(
        `SELECT file_key, file_size, book_hash, replica_kind, replica_id, created_at, updated_at
         FROM storage_files ${predicate}
         ORDER BY ${options.sortBy} ${options.sortOrder.toUpperCase()}
         LIMIT $limit OFFSET $offset`,
      )
      .all({ ...params, limit: options.pageSize, offset });
    return {
      files: rows.map(toRecord),
      total,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: Math.ceil(total / options.pageSize),
    };
  }

  stats() {
    const summary = this.database
      .query<{ total_files: number; total_size: number }, []>(
        'SELECT COUNT(*) AS total_files, COALESCE(SUM(file_size), 0) AS total_size FROM storage_files',
      )
      .get()!;
    const groups = this.database
      .query<{ book_hash: string | null; file_count: number; total_size: number }, []>(
        `SELECT book_hash, COUNT(*) AS file_count, SUM(file_size) AS total_size
         FROM storage_files GROUP BY book_hash`,
      )
      .all();
    return {
      totalFiles: summary.total_files,
      totalSize: summary.total_size,
      usage: summary.total_size,
      quota: Number.MAX_SAFE_INTEGER,
      usagePercentage: 0,
      byBookHash: groups.map((row) => ({
        bookHash: row.book_hash,
        fileCount: row.file_count,
        totalSize: row.total_size,
      })),
    };
  }

  private getRecord(fileKey: string): StoredFileRecord | null {
    const row = this.database
      .query<Record<string, string | number | null>, string>(
        `SELECT file_key, file_size, book_hash, replica_kind, replica_id, created_at, updated_at
         FROM storage_files WHERE file_key = ?`,
      )
      .get(fileKey);
    return row ? toRecord(row) : null;
  }

  private insertExisting(
    fileKey: string,
    size: number,
    bookHash: string,
    contentType: string,
  ): void {
    const now = Date.now();
    this.database
      .query(
        `INSERT OR IGNORE INTO storage_files
           (file_key, file_size, book_hash, replica_kind, replica_id, content_type, created_at, updated_at)
         VALUES ($fileKey, $size, $bookHash, NULL, NULL, $contentType, $now, $now)`,
      )
      .run({ fileKey, size, bookHash, contentType, now });
  }

  private async assertNoSymlink(target: string): Promise<void> {
    let current = target;
    while (current.startsWith(this.dataRoot) && current !== this.dataRoot) {
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new FileStoreError('Symlinks are not allowed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      current = dirname(current);
    }
  }

  private canonicalTarget(fileKey: string, bookHash?: string): string | undefined {
    if (!this.legacyObjects || !bookHash) return undefined;
    const parts = fileKey.split('/');
    if (parts[0] !== 'books' || parts[1] !== bookHash) return undefined;
    const name = parts.at(-1)!.toLowerCase();
    const extension = extname(name).slice(1);
    if (name.startsWith('cover.') && isCoverExtension(extension))
      return this.legacyObjects.coverPath(bookHash, extension);
    if (isBookFormat(extension)) return this.legacyObjects.bookPath(bookHash, extension);
    return undefined;
  }

  private async readLegacy(
    fileKey: string,
  ): Promise<{ file: ReturnType<typeof Bun.file>; contentType?: string } | null> {
    const parts = fileKey.split('/');
    if (!this.legacyObjects || parts.length < 3 || parts[0] !== 'books') return null;
    const bookHash = parts[1]!;
    const name = parts.at(-1)!.toLowerCase();
    if (name.startsWith('cover.')) {
      const cover = await this.legacyObjects.readCover(bookHash);
      return cover ? { file: Bun.file(cover.path), contentType: cover.contentType } : null;
    }
    const book = await this.legacyObjects.findBook(bookHash);
    return book ? { file: Bun.file(book.path), contentType: contentTypeFor(book.path) } : null;
  }
}

const toRecord = (row: Record<string, string | number | null>): StoredFileRecord => ({
  file_key: String(row.file_key),
  file_size: Number(row.file_size),
  book_hash: row.book_hash === null ? null : String(row.book_hash),
  replica_kind: row.replica_kind === null ? null : String(row.replica_kind),
  replica_id: row.replica_id === null ? null : String(row.replica_id),
  created_at: new Date(Number(row.created_at)).toISOString(),
  updated_at: new Date(Number(row.updated_at)).toISOString(),
});

const contentTypeFor = (path: string) => {
  const types: Record<string, string> = {
    '.epub': 'application/epub+zip',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
};
