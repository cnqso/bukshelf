import type { AuthService } from './auth';
import { FileStore, FileStoreError } from './fileStore';

export interface FileRouteConfig {
  auth: AuthService;
  files: FileStore;
  publicOrigin?: string;
}

const cors = (origin?: string) => ({
  ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});

const json = (body: unknown, config: FileRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...cors(config.publicOrigin), ...init.headers },
  });

export const handleFileRoute = async (
  request: Request,
  config: FileRouteConfig,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (url.pathname !== '/api/files' && url.pathname !== '/api/files/stats') return undefined;
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });

  try {
    if (url.pathname === '/api/files/stats' && request.method === 'GET') {
      return json(config.files.stats(), config);
    }

    const fileKey = url.searchParams.get('path');
    if (request.method === 'PUT') {
      if (!fileKey) return json({ error: 'File path is required' }, config, { status: 400 });
      const started = performance.now();
      const record = await config.files.write(fileKey, request.body, {
        bookHash: url.searchParams.get('bookHash') ?? undefined,
        replicaKind: url.searchParams.get('replicaKind') ?? undefined,
        replicaId: url.searchParams.get('replicaId') ?? undefined,
        contentType: request.headers.get('content-type') ?? undefined,
      });
      console.info(
        `[files] upload path=${JSON.stringify(fileKey)} bytes=${record.file_size} ms=${Math.round(performance.now() - started)}`,
      );
      return json({ file: record }, config, { status: 201 });
    }

    if (request.method === 'GET' && fileKey) {
      const stored = await config.files.read(fileKey);
      if (!stored) return json({ error: 'File not found' }, config, { status: 404 });
      return new Response(stored.file, {
        headers: {
          ...cors(config.publicOrigin),
          'content-type': stored.contentType ?? 'application/octet-stream',
          'content-length': String(stored.file.size),
          'cache-control': 'private, no-store',
          'content-disposition': `attachment; filename="${fileKey.split('/').at(-1)!.replace(/["\\]/g, '_')}"`,
        },
      });
    }

    if (request.method === 'GET') {
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
      const pageSize = Math.max(
        1,
        Math.min(1000, Number.parseInt(url.searchParams.get('pageSize') ?? '50', 10) || 50),
      );
      const requestedSort = url.searchParams.get('sortBy');
      const sortBy = ['created_at', 'updated_at', 'file_size', 'file_key'].includes(
        requestedSort ?? '',
      )
        ? (requestedSort as 'created_at' | 'updated_at' | 'file_size' | 'file_key')
        : 'created_at';
      return json(
        config.files.list({
          page,
          pageSize,
          sortBy,
          sortOrder: url.searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc',
          bookHash: url.searchParams.get('bookHash') ?? undefined,
          search: url.searchParams.get('search') ?? undefined,
        }),
        config,
      );
    }

    if (request.method === 'DELETE') {
      const body = (await request.json().catch(() => null)) as { paths?: unknown } | null;
      const paths = fileKey ? [fileKey] : Array.isArray(body?.paths) ? body.paths : [];
      const validPaths = paths.filter((path): path is string => typeof path === 'string');
      if (!validPaths.length)
        return json({ error: 'File path is required' }, config, { status: 400 });
      const success: string[] = [];
      const failed: Array<{ fileKey: string; error: string }> = [];
      for (const path of validPaths.slice(0, 1000)) {
        try {
          await config.files.delete(path);
          success.push(path);
        } catch (error) {
          failed.push({
            fileKey: path,
            error: error instanceof Error ? error.message : 'Delete failed',
          });
        }
      }
      return json(
        { success, failed, deletedCount: success.length, failedCount: failed.length },
        config,
      );
    }

    return json({ error: 'Method not allowed' }, config, { status: 405 });
  } catch (error) {
    if (error instanceof FileStoreError)
      return json({ error: error.message }, config, { status: 400 });
    console.error('[files] request failed', error);
    return json({ error: 'File operation failed' }, config, { status: 500 });
  }
};
