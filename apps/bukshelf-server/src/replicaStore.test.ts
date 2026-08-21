import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AuthStore } from './authStore';
import {
  ReplicaStore,
  ReplicaValidationError,
  mergeReplica,
  type ReplicaRow,
} from './replicaStore';

const owner = '123e4567-e89b-42d3-a456-426614174000';
const hlc = (offset = 0, device = 'a') =>
  `${(Date.now() + offset).toString(16).padStart(13, '0')}-00000000-${device}`;
const row = (overrides: Partial<ReplicaRow> = {}): ReplicaRow => {
  const timestamp = hlc();
  return {
    user_id: owner,
    kind: 'settings',
    replica_id: 'singleton',
    fields_jsonb: { theme: { v: 'dark', t: timestamp, s: 'a' } },
    manifest_jsonb: null,
    deleted_at_ts: null,
    reincarnation: null,
    updated_at_ts: timestamp,
    schema_version: 1,
    ...overrides,
  };
};

describe('SQLite replica synchronization', () => {
  let auth: AuthStore;
  let replicas: ReplicaStore;
  beforeEach(() => {
    auth = new AuthStore(':memory:');
    replicas = new ReplicaStore(auth.database);
  });
  afterEach(() => auth.close());

  test('converges field-by-field regardless of push order', () => {
    const first = row();
    const later = hlc(1, 'b');
    const second = row({
      fields_jsonb: {
        theme: { v: 'light', t: later, s: 'b' },
        fontSize: { v: 18, t: later, s: 'b' },
      },
      updated_at_ts: later,
    });
    expect(mergeReplica(first, second)).toEqual(mergeReplica(second, first));
    replicas.push([first]);
    replicas.push([second]);
    expect(replicas.pull('settings', null)[0]?.fields_jsonb).toMatchObject({
      theme: { v: 'light' },
      fontSize: { v: 18 },
    });
  });

  test('preserves a committed manifest across metadata-only pushes', () => {
    const timestamp = hlc();
    const committed = row({
      kind: 'font',
      replica_id: 'font-a',
      manifest_jsonb: { files: [], schemaVersion: 1 },
      updated_at_ts: timestamp,
    });
    const metadata = row({
      kind: 'font',
      replica_id: 'font-a',
      manifest_jsonb: null,
      updated_at_ts: hlc(1),
    });
    replicas.push([committed, metadata]);
    expect(replicas.pull('font', null)[0]?.manifest_jsonb).toEqual({
      files: [],
      schemaVersion: 1,
    });
  });

  test('creates salts and forgets salts plus encrypted fields only', () => {
    const key = replicas.createKey('pbkdf2-600k-sha256');
    expect(Buffer.from(key.salt, 'base64')).toHaveLength(32);
    const timestamp = hlc();
    replicas.push([
      row({
        fields_jsonb: {
          plain: { v: 'keep', t: timestamp, s: 'a' },
          secret: {
            v: { c: 'c', i: 'i', s: 's', alg: 'AES-GCM', h: 'h' },
            t: timestamp,
            s: 'a',
          },
        },
      }),
    ]);
    replicas.forgetKeys();
    expect(replicas.listKeys()).toEqual([]);
    expect(replicas.pull('settings', null)[0]?.fields_jsonb).toEqual({
      plain: { v: 'keep', t: timestamp, s: 'a' },
    });
  });

  test('rejects another user and a clock outside the skew window', () => {
    expect(() => replicas.validatePush({ rows: [row({ user_id: 'other' })] }, owner)).toThrow(
      ReplicaValidationError,
    );
    expect(() =>
      replicas.validatePush({ rows: [row({ updated_at_ts: hlc(120_000) })] }, owner),
    ).toThrow(ReplicaValidationError);
  });

  test('rejects unsafe replica manifest filenames', () => {
    expect(() =>
      replicas.validatePush(
        {
          rows: [
            row({
              manifest_jsonb: {
                files: [{ filename: '../escape', byteSize: 1, partialMd5: 'x' }],
                schemaVersion: 1,
              },
            }),
          ],
        },
        owner,
      ),
    ).toThrow(ReplicaValidationError);
  });
});
