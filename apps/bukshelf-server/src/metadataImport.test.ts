import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthStore } from './authStore';
import { importLegacyMetadata, type LegacyMetadataSource } from './metadataImport';
import { ReplicaStore, type ReplicaRow } from './replicaStore';
import { SyncStore, type SyncCollection } from './syncStore';

describe('legacy metadata import', () => {
  let database: AuthStore;
  let sync: SyncStore;
  let replicas: ReplicaStore;
  beforeEach(() => {
    database = new AuthStore(':memory:');
    sync = new SyncStore(database.database);
    replicas = new ReplicaStore(database.database);
  });
  afterEach(() => database.close());

  test('imports every metadata family idempotently', async () => {
    const timestamp = `${Date.now().toString(16).padStart(13, '0')}-00000000-device`;
    const replica: ReplicaRow = {
      user_id: 'owner',
      kind: 'settings',
      replica_id: 'singleton',
      fields_jsonb: {},
      manifest_jsonb: null,
      deleted_at_ts: null,
      reincarnation: null,
      updated_at_ts: timestamp,
      schema_version: 1,
    };
    const rows: Partial<Record<SyncCollection, Record<string, unknown>[]>> = {
      books: [
        {
          user_id: 'owner',
          book_hash: 'book-a',
          title: 'Imported',
          progress: { 0: 12, 1: 100 },
          updated_at: new Date(100).toISOString(),
          synced_at: new Date(100).toISOString(),
        },
      ],
      configs: [],
      notes: [],
      stat_books: [],
      stat_pages: [],
    };
    const source: LegacyMetadataSource = {
      async rows(collection) {
        return rows[collection] ?? [];
      },
      async replicas() {
        return [replica];
      },
      async replicaKeys() {
        return [
          {
            saltId: 'salt-a',
            alg: 'pbkdf2-600k-sha256',
            salt: 'AA==',
            createdAt: new Date(100).toISOString(),
          },
        ];
      },
    };
    const first = await importLegacyMetadata(source, sync, replicas);
    const second = await importLegacyMetadata(source, sync, replicas);
    expect(first).toMatchObject({ books: 1, replicas: 1, replicaKeys: 1 });
    expect(second).toEqual(first);
    expect(sync.publicBooks()).toHaveLength(1);
    expect(sync.publicBooks()[0]?.progress).toEqual([12, 100]);
    expect(replicas.pull('settings', null)).toHaveLength(1);
    expect(replicas.listKeys()).toHaveLength(1);
  });
});
