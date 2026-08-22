import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from './app';
import { AuthService } from './auth';
import { AuthStore } from './authStore';
import { createObjectStore, type ObjectStore } from './objectStore';
import { generateToken, hashToken, isValidToken } from './shareRoutes';
import { ShareStore } from './shareStore';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const BOOK_HASH = 'shared-book-hash';

describe('share HTTP contract', () => {
  let store: AuthStore;
  let auth: AuthService;
  let shares: ShareStore;
  let objects: ObjectStore;
  let dataDir: string;
  let handler: ReturnType<typeof createHandler>;
  let authorization: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bukshelf-share-'));
    store = new AuthStore(':memory:');
    store.createOwner({ id: ownerId, email: 'owner@example.com', passwordHash: 'unused' });
    auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
    shares = new ShareStore(store.database);
    objects = createObjectStore({ root: dataDir });
    await objects.init();
    await objects.writeBook(BOOK_HASH, 'epub', new TextEncoder().encode('book bytes'));
    await objects.writeCover(BOOK_HASH, 'jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));
    handler = createHandler({ auth, shares, objects, publicOrigin: 'http://localhost:43171' });
    authorization = `Bearer ${auth.issue(store.getOwner()!).accessToken}`;
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const createShare = async (overrides: Record<string, unknown> = {}) =>
    handler(
      new Request('http://localhost/api/share/create', {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          bookHash: BOOK_HASH,
          expirationDays: 3,
          title: 'A Shared Book',
          author: 'An Author',
          format: 'epub',
          ...overrides,
        }),
      }),
    );

  test('creates a share for an owned, existing book', async () => {
    const response = await createShare();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string; url: string; expiresAt: string };
    expect(body.token).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(body.url).toBe(`http://localhost:43171/s/${body.token}`);
  });

  test('rejects creating a share without authentication', async () => {
    const response = await handler(
      new Request('http://localhost/api/share/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bookHash: BOOK_HASH,
          expirationDays: 3,
          title: 'X',
          format: 'epub',
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test('rejects a share for a book that was never uploaded', async () => {
    const response = await createShare({ bookHash: 'never-uploaded' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('book_not_uploaded');
  });

  test('rejects an invalid expirationDays', async () => {
    const response = await createShare({ expirationDays: 30 });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_expiration');
  });

  test('public metadata resolves an active share and hides owner-only fields', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    const response = await handler(new Request(`http://localhost/api/share/${token}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      title: 'A Shared Book',
      author: 'An Author',
      format: 'epub',
      hasCover: true,
      downloadCount: 0,
    });
    expect(body.token).toBeUndefined();
    expect(body.bookHash).toBeUndefined();
  });

  test('returns 404 for an unknown token and 400 for a malformed one', async () => {
    const unknown = await handler(new Request(`http://localhost/api/share/${'a'.repeat(22)}`));
    expect(unknown.status).toBe(404);

    const malformed = await handler(new Request('http://localhost/api/share/not-a-real-token'));
    expect(malformed.status).toBe(400);
  });

  test('serves cover bytes directly and download bytes with a filename', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    const cover = await handler(new Request(`http://localhost/api/share/${token}/cover`));
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/jpeg');
    expect(cover.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xdb]),
    );

    const download = await handler(new Request(`http://localhost/api/share/${token}/download`));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('A Shared Book.epub');
    expect(await download.text()).toBe('book bytes');
  });

  test('revoke is owner-only and makes the share immediately inactive', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    const unauthorized = await handler(
      new Request(`http://localhost/api/share/${token}/revoke`, { method: 'POST' }),
    );
    expect(unauthorized.status).toBe(401);

    const revoked = await handler(
      new Request(`http://localhost/api/share/${token}/revoke`, {
        method: 'POST',
        headers: { authorization },
      }),
    );
    expect(revoked.status).toBe(204);

    const metadata = await handler(new Request(`http://localhost/api/share/${token}`));
    expect(metadata.status).toBe(410);
    expect((await metadata.json()).code).toBe('revoked');

    // Idempotent: revoking again still succeeds.
    const revokedAgain = await handler(
      new Request(`http://localhost/api/share/${token}/revoke`, {
        method: 'POST',
        headers: { authorization },
      }),
    );
    expect(revokedAgain.status).toBe(204);
  });

  test('download/confirm is a best-effort beacon that bumps the counter', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    const confirm = await handler(
      new Request(`http://localhost/api/share/${token}/download/confirm`, { method: 'POST' }),
    );
    expect(confirm.status).toBe(204);

    const garbage = await handler(
      new Request('http://localhost/api/share/not-a-real-token/download/confirm', {
        method: 'POST',
      }),
    );
    expect(garbage.status).toBe(204);

    const metadata = await handler(new Request(`http://localhost/api/share/${token}`));
    expect((await metadata.json()).downloadCount).toBe(1);
  });

  test('import requires auth and confirms the book is still owned locally', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    const unauthorized = await handler(
      new Request(`http://localhost/api/share/${token}/import`, { method: 'POST' }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await handler(
      new Request(`http://localhost/api/share/${token}/import`, {
        method: 'POST',
        headers: { authorization },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fileId: BOOK_HASH,
      alreadyOwned: true,
      bookHash: BOOK_HASH,
      cfi: null,
    });
  });

  test('enforces the active-share cap', async () => {
    for (let i = 0; i < 50; i++) {
      const response = await createShare();
      expect(response.status).toBe(200);
    }
    const overLimit = await createShare();
    expect(overLimit.status).toBe(429);
    expect((await overLimit.json()).code).toBe('share_limit_reached');
  });

  test('a share becomes source_deleted once the underlying book is gone', async () => {
    const created = await createShare();
    const { token } = (await created.json()) as { token: string };

    // Simulate the owner deleting the book after sharing it.
    await rm(objects.bookPath(BOOK_HASH, 'epub'));

    const metadata = await handler(new Request(`http://localhost/api/share/${token}`));
    expect(metadata.status).toBe(410);
    expect((await metadata.json()).code).toBe('source_deleted');
  });
});

describe('share token helpers', () => {
  test('generateToken produces a 22-char alphanumeric token, unique across calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const token = generateToken();
      expect(token).toMatch(/^[A-Za-z0-9]{22}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  test('hashToken is deterministic and matches a known SHA-256 vector', async () => {
    const first = await hashToken('abc');
    const second = await hashToken('abc');
    expect(first).toBe(second);
    expect(first).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const different = await hashToken('abd');
    expect(different).not.toBe(first);
  });

  test('isValidToken accepts only well-formed 22-char alphanumeric strings', () => {
    expect(isValidToken('aBcDeFgHiJkLmNoPqRsTuV')).toBe(true);
    expect(isValidToken('0123456789abcdefABCDEF')).toBe(true);

    expect(isValidToken('short')).toBe(false);
    expect(isValidToken('aBcDeFgHiJkLmNoPqRsTuVextra')).toBe(false);
    expect(isValidToken('')).toBe(false);
    expect(isValidToken('aBcDeFgHiJkLmNoPqRsTu-')).toBe(false);
    expect(isValidToken('aBcDeFgHiJkLmNoPqRs Tuv')).toBe(false);
    expect(isValidToken(undefined)).toBe(false);
    expect(isValidToken(null)).toBe(false);
    expect(isValidToken(42)).toBe(false);
    expect(isValidToken({})).toBe(false);
  });
});
