import type { AuthService } from './auth';
import type { OpenRouterService } from './openRouter';
import type { SonioxService } from './soniox';
import { SONIOX_MODEL, SONIOX_VOICE } from './soniox';
import type { UsageStore } from './usageStore';
import { handleUsageRoute } from './usageRoutes';

export interface ProviderRouteConfig {
  auth: AuthService;
  usage: UsageStore;
  openRouter?: OpenRouterService;
  soniox?: SonioxService;
  publicOrigin?: string;
}

const cors = (origin?: string) => ({
  ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});

const json = (body: unknown, config: ProviderRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...cors(config.publicOrigin), ...init.headers },
  });

// Streaming and binary provider responses are built without CORS headers;
// attach them here so the browser frontend can call Bun directly.
const withCors = (response: Response, config: ProviderRouteConfig): Response => {
  if (!config.publicOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', config.publicOrigin);
  headers.append('vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** Owner-authenticated Reader AI, TTS, and usage-metering endpoints. */
export const handleProviderRoutes = async (
  request: Request,
  config: ProviderRouteConfig,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path !== '/api/ai/chat' && path !== '/api/tts/soniox')
    return handleUsageRoute(request, config);

  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
  if (request.method !== 'GET' && request.method !== 'POST')
    return json({ error: 'Method not allowed' }, config, { status: 405 });
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated', code: 'AUTH' }, config, { status: 401 });

  if (path === '/api/ai/chat') {
    if (!config.openRouter)
      return json(
        { error: 'Server-managed OpenRouter is not configured', code: 'NOT_CONFIGURED' },
        config,
        { status: 503 },
      );
    if (request.method === 'GET')
      return json(
        { model: config.openRouter.chatModel, usage: config.openRouter.snapshot() },
        config,
      );
    return withCors(await config.openRouter.handleChatPost(request, session.user.id), config);
  }

  // /api/tts/soniox
  if (!config.soniox)
    return json(
      { error: { message: 'Soniox TTS is not configured', type: 'service_unavailable' } },
      config,
      { status: 503 },
    );
  if (request.method === 'GET')
    return json(
      {
        model: SONIOX_MODEL,
        voices: [{ id: SONIOX_VOICE, name: SONIOX_VOICE, language: 'en' }],
        usage: config.soniox.snapshot(),
      },
      config,
    );
  return withCors(await config.soniox.handleSynthesizePost(request, session.user.id), config);
};
