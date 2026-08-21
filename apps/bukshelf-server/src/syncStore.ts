import type { Database } from 'bun:sqlite';

export type SyncCollection = 'books' | 'configs' | 'notes' | 'stat_books' | 'stat_pages';
type JsonRow = Record<string, unknown>;

export interface SyncPayload {
  books?: JsonRow[];
  configs?: JsonRow[];
  notes?: JsonRow[];
  statBooks?: JsonRow[];
  statPages?: JsonRow[];
}

export interface PullOptions {
  since: number;
  type?: 'books' | 'configs' | 'notes' | 'stats';
  book?: string;
  metaHash?: string;
  limit?: number;
}

interface StoredRecord {
  collection: SyncCollection;
  record_key: string;
  secondary_key: string;
  book_hash: string;
  meta_hash: string | null;
  payload_json: string;
  updated_at_ms: number;
  deleted_at_ms: number;
  synced_at_ms: number;
}

const iso = (value: unknown, fallback = Date.now()): string => {
  const time =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return new Date(Number.isFinite(time) ? time : fallback).toISOString();
};
const milliseconds = (value: unknown): number => {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const nullableIso = (value: unknown): string | null => (value ? iso(value) : null);

const bookToDatabase = (row: JsonRow, userId: string): JsonRow => ({
  user_id: userId,
  book_hash: row.hash,
  meta_hash: row.metaHash,
  format: row.format,
  title: row.title,
  source_title: row.sourceTitle,
  author: row.author,
  group_id: row.groupId,
  group_name: row.groupName,
  tags: row.tags,
  progress: row.progress,
  reading_status: row.readingStatus,
  reading_status_updated_at: nullableIso(row.readingStatusUpdatedAt),
  cover_hash: row.coverHash ?? null,
  cover_updated_at: nullableIso(row.coverUpdatedAt),
  metadata: row.metadata ? JSON.stringify(row.metadata) : null,
  metadata_updated_at: nullableIso(row.metadataUpdatedAt),
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  deleted_at: nullableIso(row.deletedAt),
  uploaded_at: nullableIso(row.uploadedAt),
});

const configToDatabase = (row: JsonRow, userId: string): JsonRow => ({
  user_id: userId,
  book_hash: row.bookHash,
  meta_hash: row.metaHash,
  location: row.location,
  xpointer: row.xpointer,
  progress: row.progress ? JSON.stringify(row.progress) : null,
  rsvp_position: row.rsvpPosition ? JSON.stringify(row.rsvpPosition) : null,
  search_config: row.searchConfig ? JSON.stringify(row.searchConfig) : null,
  view_settings: row.viewSettings ? JSON.stringify(row.viewSettings) : null,
  updated_at: iso(row.updatedAt),
  deleted_at: nullableIso(row.deletedAt),
});

const noteToDatabase = (row: JsonRow, userId: string): JsonRow => ({
  user_id: userId,
  book_hash: row.bookHash,
  meta_hash: row.metaHash,
  id: row.id,
  type: row.type,
  cfi: row.cfi,
  xpointer0: row.xpointer0,
  xpointer1: row.xpointer1,
  page: row.page,
  text: row.text,
  style: row.style,
  color: row.color,
  note: row.note,
  global: row.global,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  deleted_at: nullableIso(row.deletedAt),
});

const valueTime = (row: JsonRow, field: string) => milliseconds(row[field]);

const mergeBook = (client: JsonRow, server: JsonRow, clientRowWins: boolean): JsonRow => {
  const winner = { ...(clientRowWins ? client : server) };
  const statusFromClient =
    valueTime(client, 'reading_status_updated_at') >=
    valueTime(server, 'reading_status_updated_at');
  winner.reading_status = statusFromClient ? client.reading_status : server.reading_status;
  winner.reading_status_updated_at = statusFromClient
    ? client.reading_status_updated_at
    : server.reading_status_updated_at;
  const coverFromClient =
    valueTime(client, 'cover_updated_at') >= valueTime(server, 'cover_updated_at');
  winner.cover_hash = coverFromClient ? client.cover_hash : server.cover_hash;
  winner.cover_updated_at = coverFromClient ? client.cover_updated_at : server.cover_updated_at;

  const clientMetadataTime = valueTime(client, 'metadata_updated_at');
  const serverMetadataTime = valueTime(server, 'metadata_updated_at');
  const metadataFromClient =
    clientMetadataTime === serverMetadataTime
      ? clientRowWins
      : clientMetadataTime > serverMetadataTime;
  for (const field of ['title', 'author', 'tags', 'metadata', 'metadata_updated_at']) {
    winner[field] = metadataFromClient ? client[field] : server[field];
  }
  return winner;
};

const bookFieldValuesChanged = (candidate: JsonRow, server: JsonRow): boolean =>
  (candidate.reading_status ?? null) !== (server.reading_status ?? null) ||
  (candidate.cover_hash ?? null) !== (server.cover_hash ?? null) ||
  candidate.title !== server.title ||
  candidate.author !== server.author ||
  (candidate.metadata ?? null) !== (server.metadata ?? null) ||
  JSON.stringify(candidate.tags ?? null) !== JSON.stringify(server.tags ?? null);

export class SyncStore {
  constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_records (
        collection TEXT NOT NULL,
        record_key TEXT NOT NULL,
        secondary_key TEXT NOT NULL DEFAULT '',
        book_hash TEXT NOT NULL,
        meta_hash TEXT,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        deleted_at_ms INTEGER NOT NULL DEFAULT 0,
        synced_at_ms INTEGER NOT NULL,
        PRIMARY KEY (collection, record_key, secondary_key)
      );
      CREATE INDEX IF NOT EXISTS sync_records_cursor
        ON sync_records (collection, synced_at_ms, updated_at_ms);
      CREATE INDEX IF NOT EXISTS sync_records_book ON sync_records (collection, book_hash);
      CREATE INDEX IF NOT EXISTS sync_records_meta ON sync_records (collection, meta_hash);
    `);
  }

  push(payload: SyncPayload, userId: string): Record<string, JsonRow[]> {
    const result = { books: [] as JsonRow[], configs: [] as JsonRow[], notes: [] as JsonRow[] };
    const transaction = this.database.transaction(() => {
      for (const incoming of payload.books ?? []) {
        const dbRow = bookToDatabase(incoming, userId);
        result.books.push(this.upsertClassic('books', dbRow, String(dbRow.book_hash), ''));
      }
      for (const incoming of payload.configs ?? []) {
        const dbRow = configToDatabase(incoming, userId);
        const authoritative = this.upsertClassic('configs', dbRow, String(dbRow.book_hash), '');
        result.configs.push(authoritative);
        this.piggybackProgress(authoritative);
      }
      for (const incoming of payload.notes ?? []) {
        const dbRow = noteToDatabase(incoming, userId);
        result.notes.push(
          this.upsertClassic('notes', dbRow, String(dbRow.book_hash), String(dbRow.id)),
        );
      }
      for (const incoming of payload.statBooks ?? []) this.upsertStatBook(incoming, userId);
      for (const incoming of payload.statPages ?? []) this.upsertStatPage(incoming, userId);
    });
    transaction();
    return result;
  }

  pull(options: PullOptions) {
    const result = {
      books: [] as JsonRow[],
      configs: [] as JsonRow[],
      notes: [] as JsonRow[],
      statBooks: [] as JsonRow[],
      statPages: [] as JsonRow[],
    };
    if (!options.type || options.type === 'books')
      result.books = this.pullCollection('books', options, true);
    if (!options.type || options.type === 'configs')
      result.configs = this.pullCollection('configs', options, false);
    if (!options.type || options.type === 'notes')
      result.notes = this.pullCollection('notes', options, false);
    if (!options.type || options.type === 'stats') {
      result.statBooks = this.pullCollection(
        'stat_books',
        { ...options, limit: undefined },
        false,
      ).map(withUpdatedAtMs);
      result.statPages = this.pullCollection('stat_pages', options, false).map(withUpdatedAtMs);
    }
    return result;
  }

  deleteLibrary(): void {
    this.database.query("DELETE FROM sync_records WHERE collection = 'books'").run();
  }

  import(collection: SyncCollection, payload: JsonRow): void {
    const bookHash = String(payload.book_hash ?? '');
    const secondary =
      collection === 'notes'
        ? String(payload.id ?? '')
        : collection === 'stat_pages'
          ? `${payload.page}|${payload.start_time}`
          : '';
    this.store(collection, bookHash, secondary, payload, {
      updatedAt: milliseconds(payload.updated_at),
      deletedAt: milliseconds(payload.deleted_at),
      syncedAt: milliseconds(payload.synced_at) || milliseconds(payload.updated_at),
    });
  }

  publicBooks(): JsonRow[] {
    return this.database
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM sync_records WHERE collection = 'books' AND deleted_at_ms = 0 ORDER BY updated_at_ms DESC",
      )
      .all()
      .map((row) => JSON.parse(row.payload_json) as JsonRow);
  }

  private upsertClassic(
    collection: 'books' | 'configs' | 'notes',
    client: JsonRow,
    recordKey: string,
    secondaryKey: string,
  ): JsonRow {
    if (!recordKey) throw new Error(`${collection} record is missing book hash`);
    const existing = this.get(collection, recordKey, secondaryKey);
    const now = Date.now();
    if (!existing) {
      client.updated_at = new Date(now).toISOString();
      if (!client.created_at) client.created_at = client.updated_at;
      if (collection === 'books') client.synced_at = client.updated_at;
      this.store(collection, recordKey, secondaryKey, client, {
        updatedAt: now,
        deletedAt: milliseconds(client.deleted_at),
        syncedAt: now,
      });
      return client;
    }

    const server = JSON.parse(existing.payload_json) as JsonRow;
    const clientUpdated = milliseconds(client.updated_at);
    const clientDeleted = milliseconds(client.deleted_at);
    const clientWins =
      clientDeleted > existing.deleted_at_ms || clientUpdated > existing.updated_at_ms;
    const authoritative =
      collection === 'books' ? mergeBook(client, server, clientWins) : clientWins ? client : server;
    // Match the legacy sync contract: when the server wins the row, a newer
    // field clock carrying the same value is a no-op. Persisting only that
    // clock would advance synced_at and make every peer re-pull unchanged data.
    if (collection === 'books' && !clientWins && !bookFieldValuesChanged(authoritative, server))
      return server;
    const changed = JSON.stringify(authoritative) !== JSON.stringify(server);
    if (!changed) return server;

    if (collection === 'books') authoritative.synced_at = new Date(now).toISOString();
    this.store(collection, recordKey, secondaryKey, authoritative, {
      updatedAt: milliseconds(authoritative.updated_at),
      deletedAt: milliseconds(authoritative.deleted_at),
      syncedAt: collection === 'books' ? now : milliseconds(authoritative.updated_at),
    });
    return authoritative;
  }

  private piggybackProgress(config: JsonRow): void {
    if (!config.progress) return;
    const bookHash = String(config.book_hash ?? '');
    const existing = this.get('books', bookHash, '');
    if (!existing || milliseconds(config.updated_at) <= existing.updated_at_ms) return;
    let progress: unknown;
    try {
      progress =
        typeof config.progress === 'string' ? JSON.parse(config.progress) : config.progress;
    } catch {
      return;
    }
    if (!Array.isArray(progress) || progress.length !== 2) return;
    const book = JSON.parse(existing.payload_json) as JsonRow;
    book.progress = progress;
    book.updated_at = config.updated_at;
    book.synced_at = new Date().toISOString();
    this.store('books', bookHash, '', book, {
      updatedAt: milliseconds(book.updated_at),
      deletedAt: existing.deleted_at_ms,
      syncedAt: Date.now(),
    });
  }

  private upsertStatBook(incoming: JsonRow, userId: string): void {
    const now = Date.now();
    const row: JsonRow = {
      user_id: userId,
      book_hash: incoming.book_hash,
      title: incoming.title ?? '',
      authors: incoming.authors ?? '',
      updated_at: new Date(now).toISOString(),
      deleted_at: incoming.deleted_at ?? null,
    };
    this.store('stat_books', String(row.book_hash), '', row, {
      updatedAt: now,
      deletedAt: milliseconds(row.deleted_at),
      syncedAt: now,
    });
  }

  private upsertStatPage(incoming: JsonRow, userId: string): void {
    const bookHash = String(incoming.book_hash ?? '');
    const secondary = `${incoming.page}|${incoming.start_time}`;
    const existing = this.get('stat_pages', bookHash, secondary);
    const server = existing ? (JSON.parse(existing.payload_json) as JsonRow) : null;
    if (server && Number(server.duration ?? 0) >= Number(incoming.duration ?? 0)) return;
    const now = Date.now();
    const row: JsonRow = {
      user_id: userId,
      book_hash: bookHash,
      page: incoming.page,
      start_time: incoming.start_time,
      duration: incoming.duration ?? 0,
      total_pages: incoming.total_pages ?? 0,
      ext: incoming.ext ?? null,
      updated_at: new Date(now).toISOString(),
      deleted_at: incoming.deleted_at ?? null,
    };
    this.store('stat_pages', bookHash, secondary, row, {
      updatedAt: now,
      deletedAt: milliseconds(row.deleted_at),
      syncedAt: now,
    });
  }

  private pullCollection(collection: SyncCollection, options: PullOptions, useSyncCursor: boolean) {
    const clauses = ['collection = $collection'];
    const params: Record<string, string | number> = { collection, since: options.since };
    clauses.push(
      useSyncCursor
        ? 'synced_at_ms > $since'
        : collection === 'configs' || collection === 'notes'
          ? '(updated_at_ms > $since OR deleted_at_ms > $since)'
          : 'updated_at_ms > $since',
    );
    if (options.book && options.metaHash) {
      clauses.push('(book_hash = $book OR meta_hash = $metaHash)');
      params.book = options.book;
      params.metaHash = options.metaHash;
    } else if (options.book) {
      clauses.push('book_hash = $book');
      params.book = options.book;
    } else if (options.metaHash) {
      clauses.push('meta_hash = $metaHash');
      params.metaHash = options.metaHash;
    }
    const cursor = useSyncCursor ? 'synced_at_ms' : 'updated_at_ms';
    const limit = options.limit && options.limit > 0 ? options.limit : 1_000_000;
    const rows = this.database
      .query<StoredRecord, Record<string, string | number>>(
        `SELECT * FROM sync_records WHERE ${clauses.join(' AND ')}
         ORDER BY ${cursor} ASC LIMIT $limit`,
      )
      .all({ ...params, limit });
    if (rows.length === limit && limit < 1_000_000) {
      const boundary = rows.at(-1)![cursor];
      const extra = this.database
        .query<StoredRecord, Record<string, string | number>>(
          `SELECT * FROM sync_records WHERE ${clauses.join(' AND ')} AND ${cursor} = $boundary`,
        )
        .all({ ...params, boundary });
      const seen = new Set(rows.map((row) => `${row.record_key}|${row.secondary_key}`));
      for (const row of extra) {
        const key = `${row.record_key}|${row.secondary_key}`;
        if (!seen.has(key)) rows.push(row);
      }
    }
    return rows.map((row) => JSON.parse(row.payload_json) as JsonRow);
  }

  private get(collection: SyncCollection, key: string, secondary: string): StoredRecord | null {
    return this.database
      .query<StoredRecord, [SyncCollection, string, string]>(
        'SELECT * FROM sync_records WHERE collection = ? AND record_key = ? AND secondary_key = ?',
      )
      .get(collection, key, secondary);
  }

  private store(
    collection: SyncCollection,
    key: string,
    secondary: string,
    payload: JsonRow,
    clocks: { updatedAt: number; deletedAt: number; syncedAt: number },
  ): void {
    this.database
      .query(
        `INSERT INTO sync_records
           (collection, record_key, secondary_key, book_hash, meta_hash, payload_json,
            updated_at_ms, deleted_at_ms, synced_at_ms)
         VALUES ($collection, $key, $secondary, $bookHash, $metaHash, $payload,
                 $updatedAt, $deletedAt, $syncedAt)
         ON CONFLICT(collection, record_key, secondary_key) DO UPDATE SET
           book_hash = excluded.book_hash, meta_hash = excluded.meta_hash,
           payload_json = excluded.payload_json, updated_at_ms = excluded.updated_at_ms,
           deleted_at_ms = excluded.deleted_at_ms, synced_at_ms = excluded.synced_at_ms`,
      )
      .run({
        collection,
        key,
        secondary,
        bookHash: String(payload.book_hash ?? key),
        metaHash: payload.meta_hash == null ? null : String(payload.meta_hash),
        payload: JSON.stringify(payload),
        updatedAt: clocks.updatedAt,
        deletedAt: clocks.deletedAt,
        syncedAt: clocks.syncedAt,
      });
  }
}

const withUpdatedAtMs = (row: JsonRow): JsonRow => ({
  ...row,
  updated_at_ms: milliseconds(row.updated_at),
});
