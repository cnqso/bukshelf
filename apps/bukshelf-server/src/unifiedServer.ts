import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import next from 'next';

export type BukshelfWebHandler = (request: Request) => Promise<Response> | Response;

const exactBukshelfPaths = new Set([
  '/health',
  '/.well-known/bukshelf',
  '/api/files',
  '/api/files/stats',
  '/api/sync',
  '/api/sync/replicas',
  '/api/sync/replica-keys',
  '/api/user/library',
  '/api/ai/chat',
  '/api/tts/soniox',
  '/api/usage',
  '/api/usage/summary',
  '/api/usage/events',
  '/api/public/library',
]);

/** Routes already owned by Bun. Everything else remains with Next temporarily. */
export const isBukshelfPath = (pathname: string): boolean => {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  // og.png stays a Next route (next/og's ImageResponse renderer has no Bun
  // equivalent) even though it lives under the /api/share prefix Bun owns
  // for everything else.
  if (normalized.endsWith('/og.png')) return false;
  return (
    exactBukshelfPaths.has(normalized) ||
    normalized.startsWith('/api/auth/') ||
    normalized.startsWith('/api/public/library/covers/') ||
    normalized.startsWith('/api/share')
  );
};

const appendIncomingHeaders = (headers: Headers, request: IncomingMessage): void => {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
};

export const nodeRequestToWeb = (request: IncomingMessage): Request => {
  const headers = new Headers();
  appendIncomingHeaders(headers, request);
  const forwardedProtocol = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const encrypted = Boolean(
    (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted,
  );
  const protocol = forwardedProtocol || (encrypted ? 'https' : 'http');
  const host = headers.get('host') || 'localhost';
  const method = request.method || 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(new URL(request.url || '/', `${protocol}://${host}`), init);
};

export const writeWebResponse = async (
  response: Response,
  destination: ServerResponse,
): Promise<void> => {
  destination.statusCode = response.status;
  destination.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') destination.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) destination.setHeader('set-cookie', cookies);
  if (!response.body) {
    destination.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream,
    );
    body.once('error', reject);
    destination.once('error', reject);
    destination.once('finish', resolve);
    body.pipe(destination);
  });
};

export const createUnifiedRequestListener =
  (
    bukshelf: BukshelfWebHandler,
    nextHandler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!isBukshelfPath(pathname)) {
      await nextHandler(request, response);
      return;
    }
    try {
      await writeWebResponse(await bukshelf(nodeRequestToWeb(request)), response);
    } catch (error) {
      console.error('[unified-server] Bun route failed', error);
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end('Internal Server Error');
    }
  };

export interface UnifiedServerOptions {
  bukshelf: BukshelfWebHandler;
  nextDir: string;
  hostname: string;
  port: number;
  dev: boolean;
}

export const startUnifiedServer = async (options: UnifiedServerOptions) => {
  // The Tauri build uses static export; this server always hosts the web build.
  process.env.NEXT_PUBLIC_APP_PLATFORM ||= 'web';
  const nextApp = next({
    dev: options.dev,
    dir: options.nextDir,
    hostname: options.hostname,
    port: options.port,
  });
  await nextApp.prepare();
  const server = createServer(
    createUnifiedRequestListener(options.bukshelf, nextApp.getRequestHandler()),
  );
  server.on('upgrade', nextApp.getUpgradeHandler());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await nextApp.close();
    },
  };
};
