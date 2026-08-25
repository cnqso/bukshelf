import { spawn } from 'node:child_process';

const cwd = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
let stopping = false;
let vitest;
const server = spawn('bun', ['e2e/soniox-live/server.ts'], {
  cwd,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(chunk));
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

const waitForServer = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Live Soniox proxy exited (${server.exitCode})`);
    if (
      await fetch('http://127.0.0.1:43282/health')
        .then((response) => response.ok)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out starting live Soniox proxy');
};

const stopServer = async () => {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolve) => server.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && server.exitCode === null) server.kill('SIGKILL');
};

const stopVitest = async () => {
  if (!vitest || vitest.exitCode !== null) return;
  vitest.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise((resolve) => vitest.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && vitest.exitCode === null) vitest.kill('SIGKILL');
};

const stopAll = async () => {
  if (stopping) return;
  stopping = true;
  await stopVitest();
  await stopServer();
};

const stopForSignal = (exitCode) => {
  void stopAll().finally(() => process.exit(exitCode));
};

process.once('SIGINT', () => stopForSignal(130));
process.once('SIGTERM', () => stopForSignal(143));

try {
  await waitForServer();
  vitest = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.soniox-live.config.mts'],
    { cwd, env: process.env, stdio: 'inherit' },
  );
  const exitCode = await new Promise((resolve) => vitest.once('exit', resolve));
  if (exitCode !== 0) process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
} finally {
  await stopAll();
}
