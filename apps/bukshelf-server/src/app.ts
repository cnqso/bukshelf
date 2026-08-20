import { isAbsolute, relative, resolve } from 'node:path';

export const BUKSHELF_VERSION = '0.1.0-dev';

export interface ServerConfig {
  webDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...init.headers,
    },
  });

const contentType = (pathname: string) => {
  const dot = pathname.lastIndexOf('.');
  return dot === -1 ? undefined : CONTENT_TYPES[pathname.slice(dot).toLowerCase()];
};

const safePath = (root: string, pathname: string) => {
  const candidate = resolve(root, `.${pathname}`);
  const child = relative(root, candidate);
  return child && !child.startsWith('..') && !isAbsolute(child) ? candidate : undefined;
};

const staticResponse = async (request: Request, root: string) => {
  const url = new URL(request.url);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = safePath(root, requestedPath);

  if (filePath) {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, {
        headers: contentType(filePath) ? { 'content-type': contentType(filePath)! } : undefined,
      });
    }
  }

  if (request.headers.get('accept')?.includes('text/html')) {
    const index = Bun.file(resolve(root, 'index.html'));
    if (await index.exists()) {
      return new Response(index, { headers: { 'content-type': CONTENT_TYPES['.html'] } });
    }
  }

  return undefined;
};

export const createHandler =
  (config: ServerConfig = {}) =>
  async (request: Request) => {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'bukshelf', version: BUKSHELF_VERSION });
    }

    if (url.pathname === '/.well-known/bukshelf') {
      return json({
        name: 'Bukshelf',
        version: BUKSHELF_VERSION,
        apiVersion: '0.1',
        mode: 'single-owner',
        capabilities: {
          authentication: false,
          library: false,
          sync: false,
          files: false,
          readerAI: false,
          textToSpeech: false,
          usageMetering: false,
        },
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Not found' }, { status: 404 });
    }

    if (config.webDir) {
      const response = await staticResponse(request, resolve(config.webDir));
      if (response) return response;
    }

    if (url.pathname === '/') {
      return json({
        name: 'Bukshelf',
        status: 'migration server running',
        discovery: '/.well-known/bukshelf',
      });
    }

    return json({ error: 'Not found' }, { status: 404 });
  };
