import { isAbsolute, relative, resolve } from 'node:path';
import type { AuthService } from './auth';
import { handleAuthRoute } from './authRoutes';
import { detectImageType } from './imageType';
import type { PublicLibraryService } from './publicLibrary';
import { handleFileRoute } from './fileRoutes';
import type { FileStore } from './fileStore';
import { handleSyncRoute } from './syncRoutes';
import type { SyncStore } from './syncStore';
import type { ReplicaStore } from './replicaStore';
import type { OpenRouterService } from './openRouter';
import type { SonioxService } from './soniox';
import { handleProviderRoutes } from './providerRoutes';
import type { UsageStore } from './usageStore';

export const BUKSHELF_VERSION = '0.1.0-dev';

export interface ProviderServices {
  usage: UsageStore;
  openRouter?: OpenRouterService;
  soniox?: SonioxService;
}

export interface ServerConfig {
  webDir?: string;
  publicOrigin?: string;
  publicLibrary?: PublicLibraryService;
  auth?: AuthService;
  ownerEmail?: string;
  files?: FileStore;
  sync?: SyncStore;
  replicas?: ReplicaStore;
  secureCookies?: boolean;
  providers?: ProviderServices;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const corsHeaders = (origin?: string): Record<string, string> =>
  origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        vary: 'Origin',
      }
    : {};

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

    if (config.auth) {
      const authResponse = await handleAuthRoute(request, {
        auth: config.auth,
        ownerEmail: config.ownerEmail,
        publicOrigin: config.publicOrigin,
        secureCookies: config.secureCookies ?? url.protocol === 'https:',
      });
      if (authResponse) return authResponse;

      if (config.files) {
        const fileResponse = await handleFileRoute(request, {
          auth: config.auth,
          files: config.files,
          publicOrigin: config.publicOrigin,
        });
        if (fileResponse) return fileResponse;
      }

      if (config.sync && config.replicas) {
        const syncResponse = await handleSyncRoute(request, {
          auth: config.auth,
          sync: config.sync,
          replicas: config.replicas,
          publicOrigin: config.publicOrigin,
        });
        if (syncResponse) return syncResponse;
      }

      if (config.providers) {
        const providerResponse = await handleProviderRoutes(request, {
          auth: config.auth,
          usage: config.providers.usage,
          openRouter: config.providers.openRouter,
          soniox: config.providers.soniox,
          publicOrigin: config.publicOrigin,
        });
        if (providerResponse) return providerResponse;
      }
    }

    if (url.pathname.startsWith('/api/public/library') && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(config.publicOrigin) });
    }

    if (
      url.pathname === '/api/public/library' &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      if (!config.publicLibrary) return json({ error: 'Not found' }, { status: 404 });
      try {
        const books = await config.publicLibrary.listBooks();
        const response = json(
          { books },
          {
            headers: {
              'cache-control': 'public, max-age=30, stale-while-revalidate=120',
              'x-content-type-options': 'nosniff',
              ...corsHeaders(config.publicOrigin),
            },
          },
        );
        return request.method === 'HEAD' ? new Response(null, response) : response;
      } catch (error) {
        console.error('[public-library] Failed to list books', error);
        return json(
          { error: 'Failed to load public library' },
          { status: 500, headers: corsHeaders(config.publicOrigin) },
        );
      }
    }

    const coverMatch = url.pathname.match(/^\/api\/public\/library\/covers\/([^/]+)$/);
    if (coverMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      if (!config.publicLibrary || !UUID.test(coverMatch[1]!)) {
        return json(
          { error: 'Not found' },
          { status: 404, headers: corsHeaders(config.publicOrigin) },
        );
      }
      try {
        const cover = await config.publicLibrary.getCover(coverMatch[1]!);
        if (!cover)
          return json(
            { error: 'Not found' },
            { status: 404, headers: corsHeaders(config.publicOrigin) },
          );
        const image = detectImageType(cover.body);
        if (!image)
          return json(
            { error: 'Not found' },
            { status: 404, headers: corsHeaders(config.publicOrigin) },
          );
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(cover.body), {
          headers: {
            'content-type': image.contentType,
            'content-length': String(cover.body.byteLength),
            'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
            'x-content-type-options': 'nosniff',
            // The frontend sends COEP: require-corp, so an <img> pointing at
            // another origin is blocked unless the image opts in explicitly.
            'cross-origin-resource-policy': 'cross-origin',
            ...corsHeaders(config.publicOrigin),
          },
        });
      } catch (error) {
        console.error('[public-library] Failed to load cover', error);
        return json(
          { error: 'Failed to load cover' },
          { status: 500, headers: corsHeaders(config.publicOrigin) },
        );
      }
    }

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
          authentication: Boolean(config.auth),
          library: Boolean(config.publicLibrary),
          sync: Boolean(config.auth && config.sync && config.replicas),
          files: Boolean(config.auth && config.files),
          readerAI: Boolean(config.auth && config.providers?.openRouter?.configured),
          textToSpeech: Boolean(config.auth && config.providers?.soniox?.configured),
          usageMetering: Boolean(config.auth && config.providers),
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
