import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateUserAndToken } from '@/utils/access';

describe('validateUserAndToken with Bukshelf auth', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('BUKSHELF_AUTH_ENABLED', 'true');
    vi.stubEnv('BUKSHELF_API_PUBLIC_URL', 'http://bukshelf.test');
    window.__READEST_RUNTIME_CONFIG = {
      bukshelfAuthEnabled: true,
      bukshelfApiBaseUrl: 'http://bukshelf.test',
    };
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('validates a Bukshelf bearer token through the owner session endpoint', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ user: { id: 'owner-id', email: 'owner@example.com' } }),
    );

    await expect(validateUserAndToken('Bearer owner-token')).resolves.toEqual({
      user: { id: 'owner-id', email: 'owner@example.com' },
      token: 'owner-token',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://bukshelf.test/api/auth/session', {
      headers: { Authorization: 'Bearer owner-token' },
      cache: 'no-store',
    });
  });

  it('rejects a token the Bukshelf session endpoint does not recognize', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Not authenticated' }, { status: 401 }));

    await expect(validateUserAndToken('Bearer stale-token')).resolves.toEqual({});
  });
});
