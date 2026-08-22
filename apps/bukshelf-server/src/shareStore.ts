import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/**
 * Single-owner share registry. There is exactly one owner in Bukshelf, so a
 * share row belongs to the deployment rather than to a tenant.
 */

export interface ShareRow {
  id: string;
  tokenHash: string;
  token: string;
  bookHash: string;
  bookTitle: string;
  bookAuthor: string | null;
  bookFormat: string;
  bookSize: number;
  cfi: string | null;
  expiresAt: string;
  revokedAt: string | null;
  downloadCount: number;
  createdAt: string;
}

export interface CreateShareInput {
  tokenHash: string;
  token: string;
  bookHash: string;
  bookTitle: string;
  bookAuthor: string | null;
  bookFormat: string;
  bookSize: number;
  cfi: string | null;
  expiresAt: string;
}

export interface ShareListPage {
  rows: ShareRow[];
  hasMore: boolean;
}

interface ShareTableRow {
  id: string;
  token_hash: string;
  token: string;
  book_hash: string;
  book_title: string;
  book_author: string | null;
  book_format: string;
  book_size: number;
  cfi: string | null;
  expires_at: string;
  revoked_at: string | null;
  download_count: number;
  created_at: string;
}

const toShareRow = (row: ShareTableRow): ShareRow => ({
  id: row.id,
  tokenHash: row.token_hash,
  token: row.token,
  bookHash: row.book_hash,
  bookTitle: row.book_title,
  bookAuthor: row.book_author,
  bookFormat: row.book_format,
  bookSize: row.book_size,
  cfi: row.cfi,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  downloadCount: row.download_count,
  createdAt: row.created_at,
});

export class ShareStore {
  constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS book_shares (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL,
        book_hash TEXT NOT NULL,
        book_title TEXT NOT NULL,
        book_author TEXT,
        book_format TEXT NOT NULL,
        book_size INTEGER NOT NULL,
        cfi TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        download_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS book_shares_book_hash ON book_shares (book_hash);
      CREATE INDEX IF NOT EXISTS book_shares_created_at ON book_shares (created_at, id);
    `);
  }

  /** Non-revoked shares whose expiry is still in the future. */
  countActive(now: Date = new Date()): number {
    return (
      this.database
        .query<{ count: number }, string>(
          `SELECT COUNT(*) AS count FROM book_shares
           WHERE revoked_at IS NULL AND expires_at > ?`,
        )
        .get(now.toISOString())?.count ?? 0
    );
  }

  create(input: CreateShareInput): ShareRow {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO book_shares
           (id, token_hash, token, book_hash, book_title, book_author, book_format,
            book_size, cfi, expires_at, created_at)
         VALUES ($id, $tokenHash, $token, $bookHash, $bookTitle, $bookAuthor, $bookFormat,
                 $bookSize, $cfi, $expiresAt, $createdAt)`,
      )
      .run({
        id,
        tokenHash: input.tokenHash,
        token: input.token,
        bookHash: input.bookHash,
        bookTitle: input.bookTitle,
        bookAuthor: input.bookAuthor,
        bookFormat: input.bookFormat,
        bookSize: input.bookSize,
        cfi: input.cfi,
        expiresAt: input.expiresAt,
        createdAt,
      });
    return { id, revokedAt: null, downloadCount: 0, createdAt, ...input };
  }

  findByTokenHash(tokenHash: string): ShareRow | null {
    const row = this.database
      .query<ShareTableRow, string>('SELECT * FROM book_shares WHERE token_hash = ?')
      .get(tokenHash);
    return row ? toShareRow(row) : null;
  }

  /** Idempotent: revoking an already-revoked or missing share is a no-op. */
  revoke(tokenHash: string): void {
    this.database
      .query(
        `UPDATE book_shares SET revoked_at = $now
         WHERE token_hash = $tokenHash AND revoked_at IS NULL`,
      )
      .run({ tokenHash, now: new Date().toISOString() });
  }

  /**
   * Only bumps rows that are still active, so a late-firing beacon on an
   * expired/revoked share doesn't pollute the count after the fact.
   */
  incrementDownload(tokenHash: string, now: Date = new Date()): void {
    this.database
      .query(
        `UPDATE book_shares SET download_count = download_count + 1
         WHERE token_hash = $tokenHash AND revoked_at IS NULL AND expires_at > $now`,
      )
      .run({ tokenHash, now: now.toISOString() });
  }

  /** Cursor-paginated, newest first. Cursor is opaque: "<created_at>|<id>". */
  list(options: { cursor?: string | null; pageSize: number }): ShareListPage {
    let cursorCreatedAt: string | undefined;
    let cursorId: string | undefined;
    if (options.cursor) {
      const separator = options.cursor.indexOf('|');
      if (separator > 0) {
        cursorCreatedAt = options.cursor.slice(0, separator);
        cursorId = options.cursor.slice(separator + 1);
      }
    }

    const predicate =
      cursorCreatedAt && cursorId
        ? `WHERE created_at < $cursorCreatedAt
           OR (created_at = $cursorCreatedAt AND id < $cursorId)`
        : '';
    const params: Record<string, string | number> = { limit: options.pageSize + 1 };
    if (cursorCreatedAt && cursorId) {
      params.cursorCreatedAt = cursorCreatedAt;
      params.cursorId = cursorId;
    }
    const rows = this.database
      .query<ShareTableRow, Record<string, string | number>>(
        `SELECT * FROM book_shares ${predicate}
         ORDER BY created_at DESC, id DESC
         LIMIT $limit`,
      )
      .all(params);

    const hasMore = rows.length > options.pageSize;
    return { rows: rows.slice(0, options.pageSize).map(toShareRow), hasMore };
  }
}
