import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';

export interface OwnerRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export class AuthStore {
  readonly database: Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath, { create: true, strict: true });
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry
        ON auth_sessions (expires_at, revoked_at);
    `);
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
  }

  getOwner(): OwnerRecord | null {
    const row = this.database
      .query<{ id: string; email: string; password_hash: string }, []>(
        'SELECT id, email, password_hash FROM owner WHERE singleton = 1',
      )
      .get();
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
  }

  createOwner(owner: OwnerRecord): boolean {
    const result = this.database
      .query(
        `INSERT OR IGNORE INTO owner (singleton, id, email, password_hash, password_updated_at)
         VALUES (1, $id, $email, $passwordHash, $now)`,
      )
      .run({ ...owner, now: Date.now() });
    return result.changes === 1;
  }

  resetPassword(passwordHash: string): void {
    const transaction = this.database.transaction(() => {
      const result = this.database
        .query(
          `UPDATE owner
           SET password_hash = $passwordHash, password_updated_at = $now
           WHERE singleton = 1`,
        )
        .run({ passwordHash, now: Date.now() });
      if (result.changes !== 1) throw new Error('Bukshelf owner is not configured');
      this.database
        .query('UPDATE auth_sessions SET revoked_at = $now WHERE revoked_at IS NULL')
        .run({ now: Date.now() });
    });
    transaction();
  }

  createSession(tokenId: string, expiresAt: number): void {
    const now = Date.now();
    this.database
      .query(
        `INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_used_at)
         VALUES ($tokenHash, $now, $expiresAt, $now)`,
      )
      .run({ tokenHash: hashTokenId(tokenId), now, expiresAt });
  }

  touchSession(tokenId: string, now = Date.now()): boolean {
    const result = this.database
      .query(
        `UPDATE auth_sessions
         SET last_used_at = $now
         WHERE token_hash = $tokenHash
           AND revoked_at IS NULL
           AND expires_at > $now`,
      )
      .run({ tokenHash: hashTokenId(tokenId), now });
    return result.changes === 1;
  }

  revokeSession(tokenId: string): void {
    this.database
      .query(
        `UPDATE auth_sessions
         SET revoked_at = $now
         WHERE token_hash = $tokenHash AND revoked_at IS NULL`,
      )
      .run({ tokenHash: hashTokenId(tokenId), now: Date.now() });
  }

  pruneSessions(now = Date.now()): void {
    this.database
      .query('DELETE FROM auth_sessions WHERE expires_at <= $now OR revoked_at IS NOT NULL')
      .run({ now });
  }

  close(): void {
    this.database.close();
  }
}

const hashTokenId = (tokenId: string) => createHash('sha256').update(tokenId, 'utf8').digest('hex');
