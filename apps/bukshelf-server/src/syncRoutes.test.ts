import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { createHandler } from './app';
import { ReplicaStore, type ReplicaRow } from './replicaStore';
import { SyncStore } from './syncStore';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';

describe('authenticated sync HTTP contract', () => {
  let store: AuthStore;
  let auth: AuthService;
  let sync: SyncStore;
  let replicas: ReplicaStore;
  let handler: ReturnType<typeof createHandler>;
  let authorization: string;

  beforeEach(() => {
    store = new AuthStore(':memory:');
    store.createOwner({ id: ownerId, email: 'owner@example.com', passwordHash: 'unused' });
    auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
    sync = new SyncStore(store.database);
    replicas = new ReplicaStore(store.database);
    handler = createHandler({ auth, sync, replicas });
    authorization = `Bearer ${auth.issue(store.getOwner()!).accessToken}`;
  });
  afterEach(() => store.close());

  test('pushes and incrementally pulls a library through Bun', async () => {
    const pushed = await handler(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          books: [
            {
              hash: 'book-a',
              format: 'EPUB',
              title: 'A Book',
              author: 'A Reader',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        }),
      }),
    );
    expect(pushed.status).toBe(200);
    expect((await pushed.json()).books[0]).toMatchObject({ book_hash: 'book-a' });

    const pulled = await handler(
      new Request('http://localhost/api/sync?since=0&type=books', {
        headers: { authorization },
      }),
    );
    expect(pulled.status).toBe(200);
    expect((await pulled.json()).books[0]).toMatchObject({ title: 'A Book' });
  });

  test('supports replica push, batched pull, and key lifecycle', async () => {
    const now = `${Date.now().toString(16).padStart(13, '0')}-00000000-device`;
    const row: ReplicaRow = {
      user_id: ownerId,
      kind: 'settings',
      replica_id: 'singleton',
      fields_jsonb: { theme: { v: 'dark', t: now, s: 'device' } },
      manifest_jsonb: null,
      deleted_at_ts: null,
      reincarnation: null,
      updated_at_ts: now,
      schema_version: 1,
    };
    const push = await handler(
      new Request('http://localhost/api/sync/replicas', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ rows: [row] }),
      }),
    );
    expect(push.status).toBe(200);
    const batch = await handler(
      new Request('http://localhost/api/sync/replicas', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ cursors: [{ kind: 'settings', since: null }] }),
      }),
    );
    expect((await batch.json()).results[0].rows).toHaveLength(1);

    const key = await handler(
      new Request('http://localhost/api/sync/replica-keys', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ alg: 'pbkdf2-600k-sha256' }),
      }),
    );
    expect(key.status).toBe(201);
    expect((await key.json()).row.salt).toBeTruthy();
  });

  test('rejects sync without a live owner session', async () => {
    const response = await handler(new Request('http://localhost/api/sync?since=0'));
    expect(response.status).toBe(401);
  });
});
