import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { UsageStore, type UsageEventRecord } from './usageStore';

const baseEvent = (overrides: Partial<UsageEventRecord> = {}): UsageEventRecord => ({
  requestId: 'req-1',
  provider: 'openrouter',
  operation: 'chat',
  model: 'google/gemini-3.6-flash',
  status: 'success',
  inputUnits: 100,
  outputUnits: 50,
  totalUnits: 150,
  unitsExact: true,
  createdAt: Date.UTC(2026, 0, 15, 12),
  ...overrides,
});

describe('UsageStore', () => {
  test('creates its schema idempotently on an existing database', () => {
    const database = new Database(':memory:', { strict: true });
    new UsageStore(database);
    new UsageStore(database);
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    expect(tables.filter((name) => name === 'provider_usage_events')).toHaveLength(1);
    database.close();
  });

  test('records events and reports totals', () => {
    const store = new UsageStore(new Database(':memory:', { strict: true }));
    store.record(baseEvent());
    store.record(
      baseEvent({
        requestId: 'req-2',
        status: 'failed',
        errorCategory: 'upstream_error',
        httpStatus: 502,
        unitsExact: false,
        costUsd: null,
        costSource: null,
      }),
    );
    store.record(
      baseEvent({
        requestId: 'req-3',
        status: 'rejected',
        inputUnits: 0,
        outputUnits: 0,
        totalUnits: 0,
        costUsd: null,
        costSource: null,
      }),
    );

    const totals = store.totals();
    expect(totals).toMatchObject({
      requests: 1,
      failures: 1,
      rejected: 1,
      inputUnits: 200,
      outputUnits: 100,
      totalUnits: 300,
      exactUnits: 150,
      estimatedUnits: 150,
    });
    store.database.close();
  });

  test('persists usage across a server restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bukshelf-usage-'));
    try {
      const path = join(dir, 'bukshelf.sqlite');
      const first = new UsageStore(new Database(path, { strict: true }));
      first.record(baseEvent({ costUsd: 0.25, costSource: 'provider' }));
      first.database.close();

      const second = new UsageStore(new Database(path, { strict: true }));
      expect(second.totals()).toMatchObject({ requests: 1, totalUnits: 150 });
      expect(second.totals().costUsd).toBeCloseTo(0.25);
      second.database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dayUnits excludes rejected attempts and other providers and rolls at UTC midnight', () => {
    const store = new UsageStore(new Database(':memory:', { strict: true }));
    const day = Date.UTC(2026, 0, 15);
    store.record(baseEvent({ createdAt: day + 3_600_000 }));
    store.record(baseEvent({ requestId: 'req-x', createdAt: day + 86_400_000 - 1 }));
    store.record(baseEvent({ requestId: 'req-y', status: 'rejected', createdAt: day }));
    store.record(
      baseEvent({
        requestId: 'req-z',
        provider: 'soniox',
        operation: 'tts',
        createdAt: day + 1_000,
      }),
    );

    expect(store.dayUnits('openrouter', day + 4_000)).toBe(300);
    // Next UTC day starts empty.
    expect(store.dayUnits('openrouter', day + 86_400_000)).toBe(0);
    store.database.close();
  });

  test('dailySeries groups by UTC day and provider', () => {
    const store = new UsageStore(new Database(':memory:', { strict: true }));
    const dayOne = Date.UTC(2026, 0, 14, 23);
    const dayTwo = Date.UTC(2026, 0, 15, 1);
    store.record(baseEvent({ createdAt: dayOne }));
    store.record(baseEvent({ createdAt: dayTwo, provider: 'soniox', operation: 'tts' }));

    const series = store.dailySeries(7, undefined, Date.UTC(2026, 0, 15, 20));
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ day: '2026-01-14', provider: 'openrouter' });
    expect(series[1]).toMatchObject({ day: '2026-01-15', provider: 'soniox' });
    store.database.close();
  });

  test('recentEvents returns newest first with optional provider filter and limit clamp', () => {
    const store = new UsageStore(new Database(':memory:', { strict: true }));
    for (let index = 0; index < 5; index += 1) {
      store.record(
        baseEvent({
          requestId: `req-${index}`,
          createdAt: Date.UTC(2026, 0, 15, 10, index),
        }),
      );
    }
    store.record(baseEvent({ requestId: 'tts', provider: 'soniox', operation: 'tts' }));

    const all = store.recentEvents(10);
    expect(all[0]!.request_id).toBe('tts');
    const openrouter = store.recentEvents(2, 'openrouter');
    expect(openrouter.every((row) => row.provider === 'openrouter')).toBe(true);
    expect(openrouter).toHaveLength(2);
    expect(store.recentEvents(500)).toHaveLength(6);
    store.database.close();
  });
});
