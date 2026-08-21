import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

export interface ReplicaRow {
  user_id: string;
  kind: string;
  replica_id: string;
  fields_jsonb: Record<string, FieldEnvelope>;
  manifest_jsonb: Record<string, unknown> | null;
  deleted_at_ts: string | null;
  reincarnation: string | null;
  updated_at_ts: string;
  schema_version: number;
}

interface FieldEnvelope {
  v: unknown;
  t: string;
  s: string;
}

export interface ReplicaKeyRow {
  saltId: string;
  alg: string;
  salt: string;
  createdAt: string;
}

export const REPLICA_KINDS = new Set(['dictionary', 'font', 'texture', 'opds_catalog', 'settings']);
const MAX_PUSH_BATCH = 100;
const MAX_PULL_BATCH = 50;
const MAX_FIELDS = 64;
const MAX_JSON_BYTES = 64 * 1024;
const HLC_SKEW_MS = 60_000;

export class ReplicaValidationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code = 'VALIDATION',
    readonly offendingIndex?: number,
  ) {
    super(message);
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const maximum = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return compare(a, b) >= 0 ? a : b;
};
const physicalTime = (hlc: string) => Number.parseInt(hlc.slice(0, hlc.indexOf('-')), 16);
const validFilename = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('..') &&
  !name.includes('/') &&
  !name.includes('\\') &&
  ![...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const mergeFields = (
  local: Record<string, FieldEnvelope>,
  remote: Record<string, FieldEnvelope>,
) => {
  const fields = { ...local };
  for (const [name, incoming] of Object.entries(remote)) {
    const current = fields[name];
    if (
      !current ||
      compare(incoming.t, current.t) > 0 ||
      (incoming.t === current.t && incoming.s >= current.s)
    )
      fields[name] = incoming;
  }
  return fields;
};

const contentTimestamp = (fields: Record<string, FieldEnvelope>, deleted: string | null) => {
  let timestamp = deleted;
  for (const envelope of Object.values(fields)) timestamp = maximum(timestamp, envelope.t);
  return timestamp ?? '0000000000000-00000000-';
};

export const mergeReplica = (local: ReplicaRow, incoming: ReplicaRow): ReplicaRow => {
  const fields = mergeFields(local.fields_jsonb, incoming.fields_jsonb);
  const deleted = maximum(local.deleted_at_ts, incoming.deleted_at_ts);
  const candidates = [local, incoming]
    .filter((row) => row.reincarnation !== null)
    .sort((a, b) => compare(b.updated_at_ts, a.updated_at_ts));
  const reincarnation =
    candidates[0] && (!deleted || compare(candidates[0].updated_at_ts, deleted) > 0)
      ? candidates[0].reincarnation
      : null;
  const manifest =
    incoming.manifest_jsonb === null
      ? local.manifest_jsonb
      : local.manifest_jsonb === null || compare(incoming.updated_at_ts, local.updated_at_ts) > 0
        ? incoming.manifest_jsonb
        : local.manifest_jsonb;
  return {
    user_id: local.user_id,
    kind: local.kind,
    replica_id: local.replica_id,
    fields_jsonb: fields,
    manifest_jsonb: manifest,
    deleted_at_ts: deleted,
    reincarnation,
    updated_at_ts:
      maximum(
        maximum(local.updated_at_ts, incoming.updated_at_ts),
        contentTimestamp(fields, deleted),
      ) ?? incoming.updated_at_ts,
    schema_version: Math.max(local.schema_version, incoming.schema_version),
  };
};

export class ReplicaStore {
  constructor(private readonly database: Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_replicas (
        kind TEXT NOT NULL,
        replica_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at_ts TEXT NOT NULL,
        PRIMARY KEY (kind, replica_id)
      );
      CREATE INDEX IF NOT EXISTS sync_replicas_cursor
        ON sync_replicas (kind, updated_at_ts);
      CREATE TABLE IF NOT EXISTS sync_replica_keys (
        salt_id TEXT PRIMARY KEY,
        alg TEXT NOT NULL,
        salt_b64 TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
  }

  validatePush(body: unknown, userId: string, now = Date.now()): ReplicaRow[] {
    if (!body || typeof body !== 'object' || !Array.isArray((body as { rows?: unknown }).rows))
      throw new ReplicaValidationError('body.rows must be an array', 400);
    const rows = (body as { rows: ReplicaRow[] }).rows;
    if (rows.length > MAX_PUSH_BATCH)
      throw new ReplicaValidationError(`batch size exceeds ${MAX_PUSH_BATCH}`, 413);
    rows.forEach((row, index) => this.validateRow(row, userId, now, index));
    return rows;
  }

  validateCursors(body: unknown): { kind: string; since: string | null }[] {
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { cursors?: unknown }).cursors)
    )
      throw new ReplicaValidationError('body.cursors must be an array', 400);
    const cursors = (body as { cursors: { kind: string; since: string | null }[] }).cursors;
    if (cursors.length > MAX_PULL_BATCH)
      throw new ReplicaValidationError(`cursor count exceeds ${MAX_PULL_BATCH}`, 413);
    const seen = new Set<string>();
    cursors.forEach((cursor, index) => {
      if (!REPLICA_KINDS.has(cursor.kind))
        throw new ReplicaValidationError(
          `Unknown kind: ${cursor.kind}`,
          422,
          'UNKNOWN_KIND',
          index,
        );
      if (seen.has(cursor.kind))
        throw new ReplicaValidationError(
          `Duplicate kind: ${cursor.kind}`,
          400,
          'VALIDATION',
          index,
        );
      if (cursor.since !== null && typeof cursor.since !== 'string')
        throw new ReplicaValidationError(
          'since must be a string or null',
          400,
          'VALIDATION',
          index,
        );
      seen.add(cursor.kind);
    });
    return cursors;
  }

  push(rows: ReplicaRow[]): ReplicaRow[] {
    const transaction = this.database.transaction(() =>
      rows.map((incoming) => {
        const existing = this.get(incoming.kind, incoming.replica_id);
        const merged = existing ? mergeReplica(existing, incoming) : incoming;
        this.put(merged);
        return merged;
      }),
    );
    return transaction();
  }

  pull(kind: string, since: string | null): ReplicaRow[] {
    if (!REPLICA_KINDS.has(kind))
      throw new ReplicaValidationError(`Unknown kind: ${kind}`, 422, 'UNKNOWN_KIND');
    return this.database
      .query<{ payload_json: string }, [string, string]>(
        `SELECT payload_json FROM sync_replicas
         WHERE kind = ? AND updated_at_ts > ? ORDER BY updated_at_ts ASC LIMIT 1000`,
      )
      .all(kind, since ?? '')
      .map((row) => JSON.parse(row.payload_json) as ReplicaRow);
  }

  listKeys(): ReplicaKeyRow[] {
    return this.database
      .query<{ salt_id: string; alg: string; salt_b64: string; created_at_ms: number }, []>(
        'SELECT * FROM sync_replica_keys ORDER BY created_at_ms DESC',
      )
      .all()
      .map((row) => ({
        saltId: row.salt_id,
        alg: row.alg,
        salt: row.salt_b64,
        createdAt: new Date(row.created_at_ms).toISOString(),
      }));
  }

  createKey(alg: string): ReplicaKeyRow {
    if (alg !== 'pbkdf2-600k-sha256')
      throw new ReplicaValidationError(`Unsupported alg: ${alg}`, 422, 'UNSUPPORTED_ALG');
    const row = {
      saltId: randomUUID(),
      alg,
      salt: randomBytes(32).toString('base64'),
      createdAt: new Date().toISOString(),
    };
    this.database
      .query(
        'INSERT INTO sync_replica_keys (salt_id, alg, salt_b64, created_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run(row.saltId, row.alg, row.salt, Date.parse(row.createdAt));
    return row;
  }

  forgetKeys(): void {
    const transaction = this.database.transaction(() => {
      const rows = this.database
        .query<{ kind: string; replica_id: string; payload_json: string }, []>(
          'SELECT kind, replica_id, payload_json FROM sync_replicas',
        )
        .all();
      for (const stored of rows) {
        const row = JSON.parse(stored.payload_json) as ReplicaRow;
        row.fields_jsonb = Object.fromEntries(
          Object.entries(row.fields_jsonb).filter(([, envelope]) => !isCipher(envelope.v)),
        );
        this.put(row);
      }
      this.database.exec('DELETE FROM sync_replica_keys');
    });
    transaction();
  }

  importReplica(row: ReplicaRow): void {
    this.put(row);
  }

  importKey(row: ReplicaKeyRow): void {
    this.database
      .query(
        `INSERT OR IGNORE INTO sync_replica_keys (salt_id, alg, salt_b64, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(row.saltId, row.alg, row.salt, Date.parse(row.createdAt));
  }

  private validateRow(row: ReplicaRow, userId: string, now: number, index: number): void {
    if (row.user_id !== userId)
      throw new ReplicaValidationError(
        'row user does not match authenticated user',
        403,
        'AUTH',
        index,
      );
    if (!REPLICA_KINDS.has(row.kind))
      throw new ReplicaValidationError(`Unknown kind: ${row.kind}`, 422, 'UNKNOWN_KIND', index);
    if (!row.replica_id || typeof row.fields_jsonb !== 'object' || row.fields_jsonb === null)
      throw new ReplicaValidationError('malformed replica row', 422, 'VALIDATION', index);
    if (Object.keys(row.fields_jsonb).length > MAX_FIELDS)
      throw new ReplicaValidationError('too many fields', 422, 'VALIDATION', index);
    if (new TextEncoder().encode(JSON.stringify(row.fields_jsonb)).length > MAX_JSON_BYTES)
      throw new ReplicaValidationError('fields are too large', 422, 'VALIDATION', index);
    for (const envelope of Object.values(row.fields_jsonb)) {
      if (!envelope || typeof envelope.t !== 'string' || typeof envelope.s !== 'string')
        throw new ReplicaValidationError('malformed field envelope', 422, 'VALIDATION', index);
    }
    if (row.manifest_jsonb !== null) {
      const manifest = row.manifest_jsonb as { files?: unknown; schemaVersion?: unknown };
      if (!Array.isArray(manifest.files) || !Number.isInteger(manifest.schemaVersion))
        throw new ReplicaValidationError('malformed manifest', 422, 'VALIDATION', index);
      for (const file of manifest.files) {
        const item = file as Record<string, unknown>;
        if (
          typeof item.filename !== 'string' ||
          !validFilename(item.filename) ||
          !Number.isInteger(item.byteSize) ||
          Number(item.byteSize) < 0 ||
          typeof item.partialMd5 !== 'string' ||
          (item.sha256 !== undefined &&
            (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256))) ||
          (item.mtime !== undefined && typeof item.mtime !== 'number')
        )
          throw new ReplicaValidationError('malformed manifest file', 422, 'VALIDATION', index);
      }
    }
    for (const timestamp of [row.updated_at_ts, row.deleted_at_ts].filter(Boolean) as string[]) {
      const physical = physicalTime(timestamp);
      if (!Number.isFinite(physical) || Math.abs(physical - now) > HLC_SKEW_MS)
        throw new ReplicaValidationError(
          'HLC is outside the server clock window',
          409,
          'CLOCK_SKEW',
          index,
        );
    }
    if (!Number.isInteger(row.schema_version) || row.schema_version !== 1)
      throw new ReplicaValidationError('unsupported schema version', 422, 'SCHEMA_TOO_NEW', index);
  }

  private get(kind: string, id: string): ReplicaRow | null {
    const row = this.database
      .query<{ payload_json: string }, [string, string]>(
        'SELECT payload_json FROM sync_replicas WHERE kind = ? AND replica_id = ?',
      )
      .get(kind, id);
    return row ? (JSON.parse(row.payload_json) as ReplicaRow) : null;
  }

  private put(row: ReplicaRow): void {
    this.database
      .query(
        `INSERT INTO sync_replicas (kind, replica_id, payload_json, updated_at_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, replica_id) DO UPDATE SET
           payload_json = excluded.payload_json, updated_at_ts = excluded.updated_at_ts`,
      )
      .run(row.kind, row.replica_id, JSON.stringify(row), row.updated_at_ts);
  }
}

const isCipher = (value: unknown) => typeof value === 'object' && value !== null && 'alg' in value;
