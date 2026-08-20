import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHandler } from './app';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import type { PublicLibraryService } from './publicLibrary';

const coverId = '123e4567-e89b-42d3-a456-426614174000';
const publicLibrary: PublicLibraryService = {
  async listBooks() {
    return [
      {
        id: 'opaque-book-id',
        title: 'A Public Book',
        author: 'A. Reader',
        coverUrl: `/api/public/library/covers/${coverId}`,
      },
    ];
  },
  async getCover(fileId) {
    return fileId === coverId
      ? { body: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), contentType: 'image/jpeg' }
      : null;
  },
};

describe('Bukshelf server', () => {
  let webDir: string;

  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'bukshelf-web-'));
    await Bun.write(join(webDir, 'index.html'), '<h1>Bukshelf</h1>');
    await Bun.write(join(webDir, 'app.js'), 'console.log("Bukshelf")');
  });

  afterAll(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  test('reports health', async () => {
    const response = await createHandler()(new Request('http://localhost/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'bukshelf' });
  });

  test('advertises only implemented capabilities', async () => {
    const response = await createHandler()(new Request('http://localhost/.well-known/bukshelf'));
    const body = await response.json();
    expect(body.mode).toBe('single-owner');
    expect(Object.values(body.capabilities).every((enabled) => enabled === false)).toBe(true);
  });

  test('advertises authentication only when an auth service is configured', async () => {
    const store = new AuthStore(':memory:');
    store.createOwner({ id: 'owner', email: 'owner@example.com', passwordHash: 'unused' });
    const auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
    const response = await createHandler({ auth })(
      new Request('http://localhost/.well-known/bukshelf'),
    );
    expect((await response.json()).capabilities.authentication).toBe(true);
    store.close();
  });

  test('advertises and serves the public library when configured', async () => {
    const handler = createHandler({ publicLibrary, publicOrigin: 'http://localhost:43171' });
    const discovery = await handler(new Request('http://localhost/.well-known/bukshelf'));
    expect((await discovery.json()).capabilities.library).toBe(true);

    const response = await handler(new Request('http://localhost/api/public/library'));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:43171');
    expect(await response.json()).toEqual({
      books: [
        {
          id: 'opaque-book-id',
          title: 'A Public Book',
          author: 'A. Reader',
          coverUrl: `/api/public/library/covers/${coverId}`,
        },
      ],
    });
  });

  test('serves only recognized images through opaque cover ids', async () => {
    const handler = createHandler({ publicLibrary });
    const response = await handler(
      new Request(`http://localhost/api/public/library/covers/${coverId}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.bytes()).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));

    const invalid = await handler(
      new Request('http://localhost/api/public/library/covers/not-a-uuid'),
    );
    expect(invalid.status).toBe(404);
  });

  test('lets the COEP-isolated frontend embed covers from another origin', async () => {
    const handler = createHandler({ publicLibrary, publicOrigin: 'http://localhost:43171' });
    const response = await handler(
      new Request(`http://localhost/api/public/library/covers/${coverId}`),
    );
    // Without this the browser blocks the <img> with NotSameOriginAfterDefaultedToSameOriginByCoep.
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  test('serves a configured web bundle with an SPA fallback', async () => {
    const handler = createHandler({ webDir });
    const asset = await handler(new Request('http://localhost/app.js'));
    expect(await asset.text()).toContain('console.log');

    const page = await handler(
      new Request('http://localhost/library', { headers: { accept: 'text/html' } }),
    );
    expect(await page.text()).toBe('<h1>Bukshelf</h1>');
  });

  test('does not serve files outside the web root', async () => {
    const response = await createHandler({ webDir })(
      new Request('http://localhost/../definitely-not-a-bukshelf-file'),
    );
    expect(response.status).toBe(404);
  });
});
