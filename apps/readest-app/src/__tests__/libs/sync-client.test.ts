import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/utils/access', () => ({ getAccessToken: vi.fn(async () => 'token') }));
vi.mock('@/services/environment', () => ({ getAPIBaseUrl: () => 'https://legacy.test/api' }));
vi.mock('@/services/runtimeConfig', () => ({
  getBukshelfApiBaseUrl: vi.fn(() => 'https://books.example'),
}));
vi.mock('@/utils/fetch', () => ({ fetchWithTimeout: vi.fn() }));

import { SyncClient } from '@/libs/sync';
import { fetchWithTimeout } from '@/utils/fetch';

describe('SyncClient Bukshelf routing', () => {
  beforeEach(() => vi.clearAllMocks());

  test('pulls and pushes through the direct Bun endpoint', async () => {
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(new Response(JSON.stringify({ books: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ books: [] }), { status: 200 }));
    const client = new SyncClient();
    await client.pullChanges(123, 'books');
    await client.pushChanges({ books: [] });
    expect(vi.mocked(fetchWithTimeout).mock.calls[0]![0]).toContain(
      'https://books.example/api/sync?since=123',
    );
    expect(vi.mocked(fetchWithTimeout).mock.calls[1]![0]).toBe('https://books.example/api/sync');
  });
});
