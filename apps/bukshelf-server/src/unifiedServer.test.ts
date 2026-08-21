import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createUnifiedRequestListener, isBukshelfPath } from './unifiedServer';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

const listen = async (listener: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
};

describe('unified Bun + Next server', () => {
  test('classifies only routes already owned by Bun', () => {
    for (const path of [
      '/health',
      '/.well-known/bukshelf',
      '/api/auth/login',
      '/api/files',
      '/api/sync/replicas',
      '/api/ai/chat',
      '/api/tts/soniox',
      '/api/usage/events',
      '/api/public/library/covers/123',
    ]) {
      expect(isBukshelfPath(path)).toBe(true);
    }
    for (const path of ['/', '/library', '/api/metadata/search', '/api/tts/edge', '/api/share/x']) {
      expect(isBukshelfPath(path)).toBe(false);
    }
  });

  test('serves Bun routes and delegates untouched requests to Next on one listener', async () => {
    const seen: string[] = [];
    const baseUrl = await listen(
      createUnifiedRequestListener(
        async (request) => {
          seen.push(`bun:${new URL(request.url).pathname}`);
          return Response.json(
            { body: await request.text(), authorization: request.headers.get('authorization') },
            { headers: { 'set-cookie': 'bukshelf_session=test; HttpOnly; Path=/' } },
          );
        },
        async (request, response) => {
          seen.push(`next:${request.url}`);
          response.statusCode = 202;
          response.setHeader('content-type', 'text/plain');
          response.end('next response');
        },
      ),
    );

    const bunResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner' },
      body: 'password',
    });
    expect(bunResponse.status).toBe(200);
    expect(bunResponse.headers.get('set-cookie')).toContain('bukshelf_session=test');
    expect(await bunResponse.json()).toEqual({ body: 'password', authorization: 'Bearer owner' });

    const nextResponse = await fetch(`${baseUrl}/api/metadata/search?q=book`);
    expect(nextResponse.status).toBe(202);
    expect(await nextResponse.text()).toBe('next response');
    expect(seen).toEqual(['bun:/api/auth/login', 'next:/api/metadata/search?q=book']);
  });
});
