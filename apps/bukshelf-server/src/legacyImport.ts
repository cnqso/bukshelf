import { detectImageType } from './imageType';
import { ObjectConflictError, type ObjectStore, isBookFormat } from './objectStore';

/**
 * One-shot migration from the legacy Postgres/MinIO pair into the Bukshelf
 * data directory. This is a development migration, not a compatibility layer:
 * once it has run, nothing on the serving path talks to MinIO again.
 */

export interface LegacyFileRow {
  id: string;
  bookHash: string | null;
  fileKey: string;
}

export interface LegacyObjectSource {
  listFiles(): Promise<LegacyFileRow[]>;
  /** Resolves to null when the row points at an object that is no longer stored. */
  readObject(fileKey: string): Promise<Uint8Array | null>;
}

export type ImportOutcome = 'copied' | 'skipped' | 'missing' | 'failed';

export interface ImportEntry {
  fileKey: string;
  outcome: ImportOutcome;
  reason: string;
  path?: string;
}

export interface ImportSummary {
  copied: number;
  skipped: number;
  missing: number;
  failed: number;
  entries: ImportEntry[];
}

export interface ImportOptions {
  overwrite?: boolean;
  onEntry?: (entry: ImportEntry) => void;
}

const COVER_NAME = /(?:^|\/)cover\.(png|jpe?g|webp|gif)$/i;

const extensionOf = (fileKey: string): string => {
  const name = fileKey.slice(fileKey.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
};

/** Credentials can appear in driver error messages; keys and hashes may not leave the host. */
export const redact = (value: unknown): string =>
  String(value instanceof Error ? value.message : value).replace(
    /\/\/[^/@\s]*:[^/@\s]*@/g,
    '//***:***@',
  );

export const classifyLegacyFile = (fileKey: string): 'cover' | 'book' | 'unsupported' => {
  if (COVER_NAME.test(fileKey)) return 'cover';
  return isBookFormat(extensionOf(fileKey)) ? 'book' : 'unsupported';
};

export const importLegacyObjects = async (
  source: LegacyObjectSource,
  store: ObjectStore,
  { overwrite = false, onEntry }: ImportOptions = {},
): Promise<ImportSummary> => {
  await store.init();

  const summary: ImportSummary = { copied: 0, skipped: 0, missing: 0, failed: 0, entries: [] };
  const record = (entry: ImportEntry) => {
    summary[entry.outcome] += 1;
    summary.entries.push(entry);
    onEntry?.(entry);
  };

  for (const row of await source.listFiles()) {
    const kind = classifyLegacyFile(row.fileKey);
    if (kind === 'unsupported') {
      record({ fileKey: row.fileKey, outcome: 'skipped', reason: 'unsupported object type' });
      continue;
    }
    if (!row.bookHash) {
      record({ fileKey: row.fileKey, outcome: 'skipped', reason: 'row has no book hash' });
      continue;
    }

    try {
      const body = await source.readObject(row.fileKey);
      if (!body) {
        record({ fileKey: row.fileKey, outcome: 'missing', reason: 'object not found in storage' });
        continue;
      }

      // The stored extension is never trusted: legacy JPEG bytes live under cover.png.
      const image = kind === 'cover' ? detectImageType(body) : null;
      if (kind === 'cover' && !image) {
        record({ fileKey: row.fileKey, outcome: 'failed', reason: 'unrecognized cover image' });
        continue;
      }

      const result = image
        ? await store.writeCover(row.bookHash, image.extension, body, { overwrite })
        : await store.writeBook(row.bookHash, extensionOf(row.fileKey), body, { overwrite });

      record(
        result.status === 'skipped'
          ? {
              fileKey: row.fileKey,
              outcome: 'skipped',
              reason: 'already imported',
              path: result.path,
            }
          : { fileKey: row.fileKey, outcome: 'copied', reason: result.status, path: result.path },
      );
    } catch (error) {
      record({
        fileKey: row.fileKey,
        outcome: 'failed',
        reason:
          error instanceof ObjectConflictError
            ? 'destination holds different bytes; rerun with --overwrite'
            : redact(error),
      });
    }
  }

  return summary;
};
