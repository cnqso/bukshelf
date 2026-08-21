import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const composeFile = resolve(root, 'docker/compose.bukshelf.yaml');
const suffix = randomBytes(5).toString('hex');
const project = `bukshelf-e2e-${suffix}`;
const image = `bukshelf-e2e:${suffix}`;
const password = 'docker-e2e-password';
const bookHash = 'docker-e2e-book';
const filePath = `Readest/Books/${bookHash}/Docker Restore.epub`;
const bookBytes = new TextEncoder().encode('restored docker book bytes');

const env = {
  ...process.env,
  BUKSHELF_IMAGE: image,
  BUKSHELF_HOST_PORT: '0',
  BUKSHELF_AUTH_ENABLED: 'true',
  BUKSHELF_SECURE_COOKIES: 'false',
  BUKSHELF_SESSION_SECRET: 'docker-e2e-session-secret-over-thirty-two-bytes',
  SELF_HOSTED_OWNER_EMAIL: 'docker-owner@bukshelf.test',
  SELF_HOSTED_PUBLIC_LIBRARY: 'true',
  SITE_URL: 'http://localhost',
};

const compose = (...args: string[]) => [
  'docker',
  'compose',
  '--project-name',
  project,
  '--file',
  composeFile,
  ...args,
];

const run = async (command: string[], input?: string, allowFailure = false) => {
  const process = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (input !== undefined) {
    process.stdin.write(input);
    process.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(
      `${command.join(' ')} exited ${exitCode}\n${stdout.trim()}\n${stderr.trim()}`.trim(),
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

const request = async (baseUrl: string, path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return response;
};

const assertStatus = async (response: Response, expected: number) => {
  if (response.status !== expected) {
    throw new Error(
      `${response.url} returned ${response.status}, expected ${expected}: ${await response.text()}`,
    );
  }
};

const waitForServer = async (baseUrl: string) => {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await request(baseUrl, '/health');
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Bukshelf did not become healthy: ${String(lastError)}`);
};

const login = async (baseUrl: string) => {
  const response = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  await assertStatus(response, 200);
  const body = (await response.json()) as { accessToken?: string };
  assert.ok(body.accessToken, 'login did not return an access token');
  return body.accessToken;
};

const authHeaders = (token: string, json = false) => ({
  authorization: `Bearer ${token}`,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

const start = async () => {
  await run(compose('up', '--detach', '--no-build'));
  const published = await run(compose('port', 'bukshelf', '43175'));
  const port = published.stdout.match(/:(\d+)$/)?.[1];
  assert.ok(port, `cannot parse published port: ${published.stdout}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
  return baseUrl;
};

const stop = async () => {
  await run(compose('stop', '--timeout', '10'));
};

try {
  console.log('[docker-e2e] building the production Bun image');
  await run(compose('build'));

  console.log('[docker-e2e] configuring a fresh persistent volume');
  await run(
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'bukshelf',
      'bun',
      'src/cli.ts',
      'auth',
      'setup',
      '--password-stdin',
    ),
    `${password}\n`,
  );

  console.log('[docker-e2e] cold-starting and seeding through HTTP');
  let baseUrl = await start();
  let token = await login(baseUrl);
  const now = Date.now();
  const fileUpload = await request(
    baseUrl,
    `/api/files?path=${encodeURIComponent(filePath)}&bookHash=${bookHash}`,
    {
      method: 'PUT',
      headers: authHeaders(token),
      body: bookBytes,
    },
  );
  await assertStatus(fileUpload, 201);
  const syncPush = await request(baseUrl, '/api/sync', {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify({
      books: [
        {
          hash: bookHash,
          metaHash: 'docker-e2e-meta',
          format: 'EPUB',
          title: 'Docker Restore',
          author: 'Bukshelf Test Suite',
          progress: [0, 100],
          createdAt: now,
          updatedAt: now,
          uploadedAt: now,
        },
      ],
    }),
  });
  await assertStatus(syncPush, 200);
  await stop();

  console.log('[docker-e2e] creating and verifying a stopped-server backup');
  const created = await run(
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'bukshelf',
      'bun',
      'src/backupCli.ts',
      'create',
      '--output',
      '/data/backups/e2e',
    ),
  );
  assert.match(created.stdout, /Created backup \/data\/backups\/e2e/);
  const verified = await run(
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'bukshelf',
      'bun',
      'src/backupCli.ts',
      'verify',
      '/data/backups/e2e',
    ),
  );
  assert.match(verified.stdout, /Verified \/data\/backups\/e2e/);

  console.log('[docker-e2e] deleting live metadata and bytes');
  baseUrl = await start();
  token = await login(baseUrl);
  const deletedLibrary = await request(baseUrl, '/api/user/library', {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await assertStatus(deletedLibrary, 200);
  const deletedFile = await request(baseUrl, '/api/files', {
    method: 'DELETE',
    headers: authHeaders(token, true),
    body: JSON.stringify({ paths: [filePath] }),
  });
  await assertStatus(deletedFile, 200);
  assert.equal(((await deletedFile.json()) as { deletedCount: number }).deletedCount, 1);
  const emptyPublicLibrary = await request(baseUrl, '/api/public/library');
  await assertStatus(emptyPublicLibrary, 200);
  assert.deepEqual(((await emptyPublicLibrary.json()) as { books: unknown[] }).books, []);
  const missingFile = await request(baseUrl, `/api/files?path=${encodeURIComponent(filePath)}`, {
    headers: authHeaders(token),
  });
  assert.equal(missingFile.status, 404);
  await stop();
  await run(compose('down', '--remove-orphans'));

  console.log('[docker-e2e] restoring, recreating the container, and verifying state');
  await run(
    compose(
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'bukshelf',
      'bun',
      'src/backupCli.ts',
      'restore',
      '/data/backups/e2e',
      '--force',
    ),
  );
  baseUrl = await start();
  token = await login(baseUrl);
  const restoredSync = await request(baseUrl, '/api/sync?since=0&type=books', {
    headers: authHeaders(token),
  });
  await assertStatus(restoredSync, 200);
  const restoredBooks = (await restoredSync.json()) as {
    books: Array<{ book_hash: string; title: string }>;
  };
  assert.deepEqual(
    restoredBooks.books.map(({ book_hash, title }) => ({ book_hash, title })),
    [{ book_hash: bookHash, title: 'Docker Restore' }],
  );
  const restoredFile = await request(baseUrl, `/api/files?path=${encodeURIComponent(filePath)}`, {
    headers: authHeaders(token),
  });
  await assertStatus(restoredFile, 200);
  assert.deepEqual(new Uint8Array(await restoredFile.arrayBuffer()), bookBytes);
  const publicLibrary = await request(baseUrl, '/api/public/library');
  await assertStatus(publicLibrary, 200);
  assert.deepEqual(
    ((await publicLibrary.json()) as { books: Array<{ title: string }> }).books.map(
      ({ title }) => title,
    ),
    ['Docker Restore'],
  );

  console.log('[docker-e2e] passed');
} catch (error) {
  const logs = await run(compose('logs', '--no-color'), undefined, true);
  if (logs.stdout || logs.stderr)
    console.error(`[docker-e2e] compose logs\n${logs.stdout}\n${logs.stderr}`.trim());
  throw error;
} finally {
  await run(compose('down', '--volumes', '--remove-orphans'), undefined, true);
  await run(['docker', 'image', 'rm', '--force', image], undefined, true);
}
