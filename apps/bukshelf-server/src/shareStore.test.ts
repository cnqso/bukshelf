import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ShareStore } from './shareStore';

const baseInput = (overrides: Partial<Parameters<ShareStore['create']>[0]> = {}) => ({
  tokenHash: 'hash-1',
  token: 'token-1',
  bookHash: 'book-hash-1',
  bookTitle: 'A Shared Book',
  bookAuthor: 'An Author',
  bookFormat: 'epub',
  bookSize: 1024,
  cfi: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

describe('ShareStore', () => {
  test('creates and finds a share by token hash', () => {
    const shares = new ShareStore(new Database(':memory:', { strict: true }));
    const created = shares.create(baseInput());

    expect(created.id).toBeTruthy();
    expect(created.revokedAt).toBeNull();
    expect(created.downloadCount).toBe(0);

    const found = shares.findByTokenHash('hash-1');
    expect(found).toMatchObject({ bookHash: 'book-hash-1', bookTitle: 'A Shared Book' });
    expect(shares.findByTokenHash('missing')).toBeNull();
  });

  test('counts only active (non-revoked, unexpired) shares', () => {
    const shares = new ShareStore(new Database(':memory:', { strict: true }));
    shares.create(baseInput({ tokenHash: 'active', token: 'active' }));
    shares.create(
      baseInput({
        tokenHash: 'expired',
        token: 'expired',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    shares.create(baseInput({ tokenHash: 'revoked', token: 'revoked' }));
    shares.revoke('revoked');

    expect(shares.countActive()).toBe(1);
  });

  test('revoke is idempotent and does not touch other rows', () => {
    const shares = new ShareStore(new Database(':memory:', { strict: true }));
    shares.create(baseInput({ tokenHash: 'a', token: 'a' }));
    shares.revoke('a');
    const first = shares.findByTokenHash('a')!.revokedAt;
    shares.revoke('a');
    expect(shares.findByTokenHash('a')!.revokedAt).toBe(first);
    expect(shares.findByTokenHash('missing-hash')).toBeNull();
  });

  test('incrementDownload only bumps active shares', () => {
    const shares = new ShareStore(new Database(':memory:', { strict: true }));
    shares.create(baseInput({ tokenHash: 'a', token: 'a' }));
    shares.create(baseInput({ tokenHash: 'b', token: 'b' }));
    shares.revoke('b');

    shares.incrementDownload('a');
    shares.incrementDownload('a');
    shares.incrementDownload('b');

    expect(shares.findByTokenHash('a')!.downloadCount).toBe(2);
    expect(shares.findByTokenHash('b')!.downloadCount).toBe(0);
  });

  test('lists newest first with stable cursor pagination', async () => {
    const shares = new ShareStore(new Database(':memory:', { strict: true }));
    // A real millisecond gap between creates, so created_at ordering is
    // deterministic instead of falling back to an unordered UUID tie-break —
    // exactly what real usage looks like (nobody creates five shares in the
    // same millisecond).
    for (let i = 0; i < 5; i++) {
      shares.create(baseInput({ tokenHash: `t${i}`, token: `t${i}` }));
      await Bun.sleep(2);
    }

    const firstPage = shares.list({ pageSize: 2 });
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    // Most recently created (t4) sorts first.
    expect(firstPage.rows[0]?.tokenHash).toBe('t4');

    const cursor = `${firstPage.rows[1]!.createdAt}|${firstPage.rows[1]!.id}`;
    const secondPage = shares.list({ cursor, pageSize: 2 });
    expect(secondPage.rows.map((r) => r.tokenHash)).toEqual(['t2', 't1']);

    const lastCursor = `${secondPage.rows[1]!.createdAt}|${secondPage.rows[1]!.id}`;
    const thirdPage = shares.list({ cursor: lastCursor, pageSize: 2 });
    expect(thirdPage.rows.map((r) => r.tokenHash)).toEqual(['t0']);
    expect(thirdPage.hasMore).toBe(false);
  });
});
