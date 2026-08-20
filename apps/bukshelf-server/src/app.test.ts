import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHandler } from './app';

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
