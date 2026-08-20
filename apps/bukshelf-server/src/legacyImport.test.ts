import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LegacyFileRow,
  type LegacyObjectSource,
  classifyLegacyFile,
  importLegacyObjects,
  redact,
} from './legacyImport';
import { createObjectStore } from './objectStore';

const HASH = 'bc5f8ebad04f324cd3d6546da6099be8';
const USER = '2648b8e8-5b89-47ac-a207-f3322eb43ae0';
const prefix = `${USER}/Readest/Books/${HASH}`;

// Real JPEG bytes stored under a .png key, exactly as the legacy stack does it.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x41, 0x42]);
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01]);

const row = (fileKey: string, bookHash: string | null = HASH): LegacyFileRow => ({
  id: fileKey,
  bookHash,
  fileKey,
});

const source = (
  rows: LegacyFileRow[],
  objects: Record<string, Uint8Array>,
): LegacyObjectSource => ({
  async listFiles() {
    return rows;
  },
  async readObject(fileKey) {
    return objects[fileKey] ?? null;
  },
});

describe('legacy object import', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bukshelf-import-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('classifies covers, books, and everything else', () => {
    expect(classifyLegacyFile(`${prefix}/cover.png`)).toBe('cover');
    expect(classifyLegacyFile(`${prefix}/${HASH}.epub`)).toBe('book');
    expect(classifyLegacyFile(`${prefix}/${HASH}.PDF`)).toBe('book');
    expect(classifyLegacyFile(`${USER}/Readest/config.json`)).toBe('unsupported');
  });

  test('stores covers under their real image type, not their legacy key', async () => {
    const store = createObjectStore({ root });
    const summary = await importLegacyObjects(
      source([row(`${prefix}/cover.png`), row(`${prefix}/${HASH}.epub`)], {
        [`${prefix}/cover.png`]: JPEG,
        [`${prefix}/${HASH}.epub`]: EPUB,
      }),
      store,
    );

    expect(summary).toMatchObject({ copied: 2, skipped: 0, missing: 0, failed: 0 });
    expect((await store.readCover(HASH))?.contentType).toBe('image/jpeg');
    expect((await store.readCover(HASH))?.path).toBe(store.coverPath(HASH, 'jpg'));
    expect(await store.findBook(HASH)).toMatchObject({ format: 'epub' });
  });

  test('is idempotent: a second run copies nothing', async () => {
    const store = createObjectStore({ root });
    const rows = [row(`${prefix}/cover.png`)];
    const objects = { [`${prefix}/cover.png`]: JPEG };

    await importLegacyObjects(source(rows, objects), store);
    const rerun = await importLegacyObjects(source(rows, objects), store);

    expect(rerun).toMatchObject({ copied: 0, skipped: 1, missing: 0, failed: 0 });
    expect(rerun.entries[0]).toMatchObject({ outcome: 'skipped', reason: 'already imported' });
  });

  test('fails loudly on a conflicting destination unless overwrite is requested', async () => {
    const store = createObjectStore({ root });
    await store.writeCover(HASH, 'jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x99]));

    const rows = [row(`${prefix}/cover.png`)];
    const objects = { [`${prefix}/cover.png`]: JPEG };

    const conflicted = await importLegacyObjects(source(rows, objects), store);
    expect(conflicted).toMatchObject({ copied: 0, failed: 1 });
    expect(conflicted.entries[0]?.reason).toContain('--overwrite');

    const forced = await importLegacyObjects(source(rows, objects), store, { overwrite: true });
    expect(forced).toMatchObject({ copied: 1, failed: 0 });
    expect((await store.readCover(HASH))?.body).toEqual(JPEG);
  });

  test('counts missing objects, unsupported keys, hashless rows, and bad images', async () => {
    const store = createObjectStore({ root });
    const summary = await importLegacyObjects(
      source(
        [
          row(`${prefix}/cover.png`),
          row(`${USER}/Readest/config.json`),
          row(`${prefix}/${HASH}.epub`, null),
          row(`${USER}/Readest/Books/other/cover.gif`, 'other'),
        ],
        { [`${USER}/Readest/Books/other/cover.gif`]: new Uint8Array([1, 2, 3, 4, 5, 6]) },
      ),
      store,
    );

    expect(summary).toMatchObject({ copied: 0, skipped: 2, missing: 1, failed: 1 });
    expect(summary.entries.map((entry) => entry.outcome)).toEqual([
      'missing',
      'skipped',
      'skipped',
      'failed',
    ]);
  });

  test('never repeats credentials found in driver errors', () => {
    expect(redact(new Error('connect postgres://postgres:hunter2@127.0.0.1:43176/postgres'))).toBe(
      'connect postgres://***:***@127.0.0.1:43176/postgres',
    );
  });
});
