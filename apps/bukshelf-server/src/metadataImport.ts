import type { ReplicaKeyRow, ReplicaRow, ReplicaStore } from './replicaStore';
import type { SyncCollection, SyncStore } from './syncStore';

export interface LegacyMetadataSource {
  rows(collection: SyncCollection): Promise<Record<string, unknown>[]>;
  replicas(): Promise<ReplicaRow[]>;
  replicaKeys(): Promise<ReplicaKeyRow[]>;
}

export interface MetadataImportSummary {
  books: number;
  configs: number;
  notes: number;
  statBooks: number;
  statPages: number;
  replicas: number;
  replicaKeys: number;
}

export const importLegacyMetadata = async (
  source: LegacyMetadataSource,
  sync: SyncStore,
  replicas: ReplicaStore,
): Promise<MetadataImportSummary> => {
  const collections: Array<[SyncCollection, keyof MetadataImportSummary]> = [
    ['books', 'books'],
    ['configs', 'configs'],
    ['notes', 'notes'],
    ['stat_books', 'statBooks'],
    ['stat_pages', 'statPages'],
  ];
  const summary: MetadataImportSummary = {
    books: 0,
    configs: 0,
    notes: 0,
    statBooks: 0,
    statPages: 0,
    replicas: 0,
    replicaKeys: 0,
  };
  for (const [collection, counter] of collections) {
    const rows = await source.rows(collection);
    for (const row of rows) sync.import(collection, normalizeLegacyRow(collection, row));
    summary[counter] = rows.length;
  }
  const replicaRows = await source.replicas();
  for (const row of replicaRows) replicas.importReplica(normalize(row) as unknown as ReplicaRow);
  summary.replicas = replicaRows.length;
  const keys = await source.replicaKeys();
  for (const row of keys) replicas.importKey(row);
  summary.replicaKeys = keys.length;
  return summary;
};

const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const postgresArray = (value: unknown): unknown => {
  if (Array.isArray(value) || value == null) return value;
  if (typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([key]) => /^\d+$/.test(key))) return value;
  return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, item]) => item);
};

const normalizeLegacyRow = (
  collection: SyncCollection,
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const row = normalize(value);
  if (collection === 'books') {
    row.progress = postgresArray(row.progress);
    row.tags = postgresArray(row.tags);
  }
  if (collection === 'stat_pages' && typeof row.start_time === 'string') {
    row.start_time = Number(row.start_time);
  }
  return row;
};
