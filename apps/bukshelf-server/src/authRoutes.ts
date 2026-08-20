import type { AuthService } from './auth';

export interface AuthRouteConfig {
  auth: AuthService;
  publicOrigin?: string;
  secureCookies: boolean;
}

const attempts: number[] = [];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;

const canAttemptLogin = () => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  while (attempts[0] && attempts[0] < cutoff) attempts.shift();
  return attempts.length < LOGIN_ATTEMPT_LIMIT;
};

const corsHeaders = (origin?: string) => ({
  ...(origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        vary: 'Origin',
      }
    : {}),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});

const json = (body: unknown, config: AuthRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: {
      'cache-control': 'no-store',
      ...corsHeaders(config.publicOrigin),
      ...init.headers,
    },
  });

export const handleAuthRoute = async (
  request: Request,
  config: AuthRouteConfig,
): Promise<Response | undefined> => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/auth/')) return undefined;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(config.publicOrigin) });
  }

  if (pathname === '/api/auth/status' && request.method === 'GET') {
    return json({ configured: Boolean(config.auth.owner) }, config);
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (!canAttemptLogin()) {
      return json({ error: 'Too many login attempts. Try again later.' }, config, { status: 429 });
    }
    attempts.push(Date.now());
    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    if (typeof body?.password !== 'string') {
      return json({ error: 'Password is required' }, config, { status: 400 });
    }
    const session = await config.auth.login(body.password);
    if (!session) {
      return json({ error: 'Invalid password' }, config, { status: 401 });
    }
    attempts.length = 0;
    return json(
      { accessToken: session.accessToken, expiresAt: session.expiresAt, user: session.user },
      config,
      {
        headers: {
          'set-cookie': config.auth.sessionCookie(session.accessToken, config.secureCookies),
        },
      },
    );
  }

  if (pathname === '/api/auth/session' && request.method === 'GET') {
    const session = config.auth.authenticate(request);
    if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });
    return json(
      { accessToken: session.accessToken, expiresAt: session.expiresAt, user: session.user },
      config,
    );
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const session = config.auth.authenticate(request);
    if (session) config.auth.revoke(session);
    return json({ ok: true }, config, {
      headers: { 'set-cookie': config.auth.clearSessionCookie(config.secureCookies) },
    });
  }

  return json({ error: 'Not found' }, config, { status: 404 });
};
