import type { AuthService } from './auth';
import { ReplicaStore, ReplicaValidationError } from './replicaStore';
import { SyncStore, type SyncPayload } from './syncStore';

export interface SyncRouteConfig {
  auth: AuthService;
  sync: SyncStore;
  replicas: ReplicaStore;
  publicOrigin?: string;
}

const paths = new Set([
  '/api/sync',
  '/api/sync/replicas',
  '/api/sync/replica-keys',
  '/api/user/library',
]);
const cors = (origin?: string) => ({
  ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});
const json = (body: unknown, config: SyncRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...cors(config.publicOrigin), ...init.headers },
  });

export const handleSyncRoute = async (
  request: Request,
  config: SyncRouteConfig,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (!paths.has(url.pathname)) return undefined;
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated', code: 'AUTH' }, config, { status: 401 });

  try {
    if (url.pathname === '/api/sync') {
      if (request.method === 'GET') {
        const rawSince = url.searchParams.get('since');
        const since = rawSince === null ? NaN : Number(rawSince);
        if (!Number.isFinite(since))
          return json({ error: 'Invalid or missing "since" timestamp' }, config, { status: 400 });
        const type = url.searchParams.get('type') || undefined;
        if (type && !['books', 'configs', 'notes', 'stats'].includes(type))
          return json({ error: 'Invalid sync type' }, config, { status: 400 });
        const result = config.sync.pull({
          since,
          type: type as 'books' | 'configs' | 'notes' | 'stats' | undefined,
          book: url.searchParams.get('book') || undefined,
          metaHash: url.searchParams.get('meta_hash') || undefined,
          limit: Math.max(0, Number.parseInt(url.searchParams.get('limit') ?? '0', 10) || 0),
        });
        return json(result, config);
      }
      if (request.method === 'POST') {
        const body = (await request.json()) as SyncPayload;
        const started = performance.now();
        const result = config.sync.push(body, session.user.id);
        console.info(
          `[sync] push books=${body.books?.length ?? 0} configs=${body.configs?.length ?? 0} notes=${body.notes?.length ?? 0} statBooks=${body.statBooks?.length ?? 0} statPages=${body.statPages?.length ?? 0} ms=${Math.round(performance.now() - started)}`,
        );
        return json(result, config);
      }
      return json({ error: 'Method not allowed' }, config, { status: 405 });
    }

    if (url.pathname === '/api/sync/replicas') {
      if (request.method === 'GET') {
        const kind = url.searchParams.get('kind');
        if (!kind)
          return json({ error: 'kind query parameter required', code: 'VALIDATION' }, config, {
            status: 400,
          });
        return json({ rows: config.replicas.pull(kind, url.searchParams.get('since')) }, config);
      }
      if (request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        if ('cursors' in body) {
          const cursors = config.replicas.validateCursors(body);
          return json(
            {
              results: cursors.map(({ kind, since }) => ({
                kind,
                rows: config.replicas.pull(kind, since),
              })),
            },
            config,
          );
        }
        const rows = config.replicas.validatePush(body, session.user.id);
        return json({ rows: config.replicas.push(rows) }, config);
      }
      return json({ error: 'Method not allowed' }, config, { status: 405 });
    }

    if (url.pathname === '/api/sync/replica-keys') {
      if (request.method === 'GET') return json({ rows: config.replicas.listKeys() }, config);
      if (request.method === 'POST') {
        const body = (await request.json()) as { alg?: unknown };
        return json({ row: config.replicas.createKey(String(body.alg)) }, config, { status: 201 });
      }
      if (request.method === 'DELETE') {
        config.replicas.forgetKeys();
        return json({ ok: true }, config);
      }
      return json({ error: 'Method not allowed' }, config, { status: 405 });
    }

    if (url.pathname === '/api/user/library' && request.method === 'DELETE') {
      config.sync.deleteLibrary();
      return json({ message: 'Cloud library deleted successfully' }, config);
    }
    return json({ error: 'Method not allowed' }, config, { status: 405 });
  } catch (error) {
    if (error instanceof ReplicaValidationError)
      return json(
        {
          error: error.message,
          code: error.code,
          ...(error.offendingIndex === undefined ? {} : { offendingIndex: error.offendingIndex }),
        },
        config,
        { status: error.status },
      );
    console.error('[sync] request failed', error);
    return json({ error: error instanceof Error ? error.message : 'Sync failed' }, config, {
      status: 500,
    });
  }
};
