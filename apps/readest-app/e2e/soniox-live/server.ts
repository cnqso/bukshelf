import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHandler } from '../../../bukshelf-server/src/app';
import { AuthService } from '../../../bukshelf-server/src/auth';
import { AuthStore } from '../../../bukshelf-server/src/authStore';
import { SonioxService, createSonioxConfigFromEnv } from '../../../bukshelf-server/src/soniox';
import { UsageStore } from '../../../bukshelf-server/src/usageStore';

const PORT = 43_282;
const BROWSER_ORIGIN = '*';
const OWNER = {
  id: '123e4567-e89b-42d3-a456-426614174001',
  email: 'soniox-live@bukshelf.test',
  passwordHash: 'unused-by-live-test',
};

if (!process.env.SONIOX_API_KEY) throw new Error('SONIOX_API_KEY is required for the live test');

const dataDir = await mkdtemp(join(tmpdir(), 'bukshelf-soniox-live-'));
const authStore = new AuthStore(join(dataDir, 'bukshelf.sqlite'));
authStore.createOwner(OWNER);
const auth = new AuthService(
  authStore,
  'bukshelf-soniox-live-session-secret-over-thirty-two-bytes',
);
const session = auth.issue(OWNER);
const usage = new UsageStore(authStore.database);
const soniox = new SonioxService(
  {
    ...createSonioxConfigFromEnv(),
    // A live regression run is intentionally small and must never fan out.
    maxConcurrent: 1,
    maxQueueSize: 2,
    requestsPerMinute: 30,
    tokensPerMinutePerUser: 2_000,
    tokensPerDay: 2_000,
  },
  usage,
);
const app = createHandler({
  auth,
  providers: { usage, soniox },
  publicOrigin: BROWSER_ORIGIN,
  secureCookies: false,
});

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path === '/__test/session') {
      return Response.json(
        { accessToken: session.accessToken },
        { headers: { 'access-control-allow-origin': BROWSER_ORIGIN } },
      );
    }
    return (await app(request)) ?? new Response('Not found', { status: 404 });
  },
});

console.log(`Live Soniox test proxy listening on ${server.url}`);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.stop(true);
  authStore.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
};

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
