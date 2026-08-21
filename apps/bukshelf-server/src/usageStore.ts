export interface UsageTotals {
  requests: number;
  failures: number;
  rejected: number;
  inputUnits: number;
  outputUnits: number;
  totalUnits: number;
  exactUnits: number;
  estimatedUnits: number;
  costUsd: number;
}

export interface UsageEventRecord {
  requestId: string;
  provider: string;
  operation: string;
  model: string;
  ownerId?: string | null;
  status: 'success' | 'failed' | 'rejected';
  httpStatus?: number | null;
  inputUnits?: number | null;
  outputUnits?: number | null;
  totalUnits?: number | null;
  unitsExact?: boolean;
  costUsd?: number | null;
  costSource?: 'provider' | 'estimated' | null;
  durationMs?: number | null;
  errorCategory?: string | null;
}

export interface UsageEventRow {
  id: number;
  request_id: string;
  provider: string;
  operation: string;
  model: string;
  owner_id: string | null;
  status: string;
  http_status: number | null;
  input_units: number;
  output_units: number;
  total_units: number;
  units_exact: number;
  cost_usd: number | null;
  cost_source: string | null;
  duration_ms: number | null;
  error_category: string | null;
  created_at: number;
}

export interface DailyUsageRow {
  day: string;
  provider: string;
  requests: number;
  failures: number;
  rejected: number;
  input_units: number;
  output_units: number;
  total_units: number;
  exact_units: number;
  estimated_units: number;
  cost_usd: number;
}

const DAY_MS = 86_400_000;

const startOfUtcDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const EMPTY_TOTALS = (): UsageTotals => ({
  requests: 0,
  failures: 0,
  rejected: 0,
  inputUnits: 0,
  outputUnits: 0,
  totalUnits: 0,
  exactUnits: 0,
  estimatedUnits: 0,
  costUsd: 0,
});

/**
 * Persistent accounting for every provider request (chat, TTS) in one SQLite
 * table. The store is the metering authority: daily budgets and dashboards
 * read from it, so numbers survive server restarts. Table creation is
 * idempotent so an existing Bukshelf database migrates safely on startup.
 */
export class UsageStore {
  constructor(readonly database: import('bun:sqlite').Database) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        model TEXT NOT NULL,
        owner_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'rejected')),
        http_status INTEGER,
        input_units INTEGER NOT NULL DEFAULT 0,
        output_units INTEGER NOT NULL DEFAULT 0,
        total_units INTEGER NOT NULL DEFAULT 0,
        units_exact INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_source TEXT CHECK (cost_source IS NULL OR cost_source IN ('provider', 'estimated')),
        duration_ms INTEGER,
        error_category TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_usage_events_time
        ON provider_usage_events (created_at);
      CREATE INDEX IF NOT EXISTS provider_usage_events_provider_time
        ON provider_usage_events (provider, created_at);
    `);
  }

  record(event: UsageEventRecord, now = Date.now()): void {
    const inputUnits = event.inputUnits ?? 0;
    const outputUnits = event.outputUnits ?? 0;
    this.database
      .query(
        `INSERT INTO provider_usage_events
           (request_id, provider, operation, model, owner_id, status, http_status,
            input_units, output_units, total_units, units_exact, cost_usd, cost_source,
            duration_ms, error_category, created_at)
         VALUES ($requestId, $provider, $operation, $model, $ownerId, $status, $httpStatus,
                 $inputUnits, $outputUnits, $totalUnits, $unitsExact, $costUsd, $costSource,
                 $durationMs, $errorCategory, $createdAt)`,
      )
      .run({
        requestId: event.requestId,
        provider: event.provider,
        operation: event.operation,
        model: event.model,
        ownerId: event.ownerId ?? null,
        status: event.status,
        httpStatus: event.httpStatus ?? null,
        inputUnits,
        outputUnits,
        totalUnits: event.totalUnits ?? inputUnits + outputUnits,
        unitsExact: event.unitsExact ? 1 : 0,
        costUsd: event.costUsd ?? null,
        costSource: event.costSource ?? null,
        durationMs: event.durationMs ?? null,
        errorCategory: event.errorCategory ?? null,
        createdAt: event.createdAt ?? now,
      });
  }

  totals(provider?: string, sinceMs?: number): UsageTotals {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (provider) {
      clauses.push('provider = $provider');
      params.provider = provider;
    }
    if (sinceMs !== undefined) {
      clauses.push('created_at >= $since');
      params.since = sinceMs;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = this.database
      .query<
        {
          success: number;
          failed: number;
          rejected: number;
          input_units: number;
          output_units: number;
          total_units: number;
          exact_units: number;
          estimated_units: number;
          cost_usd: number | null;
        },
        Record<string, unknown>
      >(
        `SELECT
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           COALESCE(SUM(input_units), 0) AS input_units,
           COALESCE(SUM(output_units), 0) AS output_units,
           COALESCE(SUM(total_units), 0) AS total_units,
           COALESCE(SUM(CASE WHEN units_exact = 1 THEN total_units ELSE 0 END), 0) AS exact_units,
           COALESCE(SUM(CASE WHEN units_exact = 0 THEN total_units ELSE 0 END), 0) AS estimated_units,
           SUM(cost_usd) AS cost_usd
         FROM provider_usage_events ${where}`,
      )
      .get(params);
    if (!row) return EMPTY_TOTALS();
    return {
      requests: row.success ?? 0,
      failures: row.failed ?? 0,
      rejected: row.rejected ?? 0,
      inputUnits: row.input_units ?? 0,
      outputUnits: row.output_units ?? 0,
      totalUnits: row.total_units ?? 0,
      exactUnits: row.exact_units ?? 0,
      estimatedUnits: row.estimated_units ?? 0,
      costUsd: row.cost_usd ?? 0,
    };
  }

  /** Units counted toward the daily budget; rejected attempts never count. */
  dayUnits(provider: string, now = Date.now()): number {
    const dayStart = startOfUtcDay(now);
    const row = this.database
      .query<{ units: number }, [string, number, number]>(
        `SELECT COALESCE(SUM(total_units), 0) AS units
         FROM provider_usage_events
         WHERE provider = ? AND status != 'rejected'
           AND created_at >= ? AND created_at < ?`,
      )
      .get(provider, dayStart, dayStart + DAY_MS);
    return row?.units ?? 0;
  }

  dailySeries(daysBack: number, provider?: string, now = Date.now()): DailyUsageRow[] {
    const todayStart = startOfUtcDay(now);
    const since = todayStart - Math.max(0, daysBack - 1) * DAY_MS;
    const clauses = ['created_at >= ?', 'created_at < ?'];
    const params: unknown[] = [since, todayStart + DAY_MS];
    if (provider) {
      clauses.push('provider = ?');
      params.push(provider);
    }
    const rows = this.database
      .query<
        {
          day_start: number;
          provider: string;
          success: number;
          failed: number;
          rejected: number;
          input_units: number;
          output_units: number;
          total_units: number;
          exact_units: number;
          estimated_units: number;
          cost_usd: number | null;
        },
        unknown[]
      >(
        `SELECT
           (created_at / ${DAY_MS}) * ${DAY_MS} AS day_start,
           provider,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(input_units) AS input_units,
           SUM(output_units) AS output_units,
           SUM(total_units) AS total_units,
           SUM(CASE WHEN units_exact = 1 THEN total_units ELSE 0 END) AS exact_units,
           SUM(CASE WHEN units_exact = 0 THEN total_units ELSE 0 END) AS estimated_units,
           SUM(cost_usd) AS cost_usd
         FROM provider_usage_events
         WHERE ${clauses.join(' AND ')}
         GROUP BY day_start, provider
         ORDER BY day_start ASC`,
      )
      .all(...params);
    return rows.map((row) => ({
      day: new Date(row.day_start).toISOString().slice(0, 10),
      provider: row.provider,
      requests: row.success ?? 0,
      failures: row.failed ?? 0,
      rejected: row.rejected ?? 0,
      input_units: row.input_units ?? 0,
      output_units: row.output_units ?? 0,
      total_units: row.total_units ?? 0,
      exact_units: row.exact_units ?? 0,
      estimated_units: row.estimated_units ?? 0,
      cost_usd: row.cost_usd ?? 0,
    }));
  }

  recentEvents(limit: number, provider?: string): UsageEventRow[] {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    if (provider) {
      return this.database
        .query<UsageEventRow, [string, number]>(
          `SELECT * FROM provider_usage_events WHERE provider = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(provider, safeLimit);
    }
    return this.database
      .query<UsageEventRow, [number]>(
        'SELECT * FROM provider_usage_events ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(safeLimit);
  }
}
