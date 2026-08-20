import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthService } from './auth';
import { handleAuthRoute } from './authRoutes';
import { AuthStore } from './authStore';

describe('single-owner authentication', () => {
  const store = new AuthStore(':memory:');
  let auth: AuthService;

  beforeAll(async () => {
    store.createOwner({
      id: '2648b8e8-5b89-47ac-a207-f3322eb43ae0',
      email: 'owner@example.com',
      passwordHash: await Bun.password.hash('correct horse battery staple', {
        algorithm: 'argon2id',
      }),
    });
    auth = new AuthService(store, 'test-secret-that-is-deliberately-over-thirty-two-bytes');
  });

  afterAll(() => store.close());

  test('rejects an incorrect password', async () => {
    expect(await auth.login('wrong password')).toBeNull();
  });

  test('issues a Supabase-compatible owner JWT and persists its session', async () => {
    const session = await auth.login('correct horse battery staple');
    expect(session?.user).toMatchObject({
      id: '2648b8e8-5b89-47ac-a207-f3322eb43ae0',
      email: 'owner@example.com',
      role: 'authenticated',
    });
    const payload = JSON.parse(
      Buffer.from(session!.accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    );
    expect(payload).toMatchObject({
      aud: 'authenticated',
      role: 'authenticated',
      plan: 'purchase',
    });
    expect(payload.session_id).toBeUndefined();
    expect(
      auth.authenticate(
        new Request('http://localhost/api/auth/session', {
          headers: { authorization: `Bearer ${session!.accessToken}` },
        }),
      ),
    ).not.toBeNull();
  });

  test('supports login, cookie restore, and logout through HTTP routes', async () => {
    const config = {
      auth,
      publicOrigin: 'http://localhost:43171',
      secureCookies: false,
    };
    const login = await handleAuthRoute(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          password: 'correct horse battery staple',
        }),
      }),
      config,
    );
    expect(login?.status).toBe(200);
    expect(login?.headers.get('access-control-allow-credentials')).toBe('true');
    const cookie = login!.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');

    const restored = await handleAuthRoute(
      new Request('http://localhost/api/auth/session', { headers: { cookie } }),
      config,
    );
    expect(restored?.status).toBe(200);

    const logout = await handleAuthRoute(
      new Request('http://localhost/api/auth/logout', {
        method: 'POST',
        headers: { cookie },
      }),
      config,
    );
    expect(logout?.status).toBe(200);
    const rejected = await handleAuthRoute(
      new Request('http://localhost/api/auth/session', { headers: { cookie } }),
      config,
    );
    expect(rejected?.status).toBe(401);
  });

  test('password reset revokes every existing session', async () => {
    const session = await auth.login('correct horse battery staple');
    store.resetPassword(
      await Bun.password.hash('a completely different password', { algorithm: 'argon2id' }),
    );
    expect(
      auth.authenticate(
        new Request('http://localhost/api/auth/session', {
          headers: { authorization: `Bearer ${session!.accessToken}` },
        }),
      ),
    ).toBeNull();
  });
});

test('sessions survive a server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bukshelf-auth-'));
  const databasePath = join(directory, 'bukshelf.sqlite');
  const secret = 'test-secret-that-is-deliberately-over-thirty-two-bytes';
  try {
    const firstStore = new AuthStore(databasePath);
    firstStore.createOwner({ id: 'owner', email: 'owner@example.com', passwordHash: 'unused' });
    const firstAuth = new AuthService(firstStore, secret);
    const session = firstAuth.issue(firstAuth.owner!);
    firstStore.close();

    const restartedStore = new AuthStore(databasePath);
    const restartedAuth = new AuthService(restartedStore, secret);
    expect(
      restartedAuth.authenticate(
        new Request('http://localhost/api/auth/session', {
          headers: { authorization: `Bearer ${session.accessToken}` },
        }),
      ),
    ).not.toBeNull();
    restartedStore.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
