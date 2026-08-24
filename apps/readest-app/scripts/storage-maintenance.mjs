#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { access, rm, statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appDir, '../..');
const minimumFreeBytes = 30 * 1024 ** 3;
const mode = process.argv[2] ?? 'status';
const dryRun = process.argv.includes('--dry-run');

const artifacts = [
  resolve(repoRoot, 'target'),
  resolve(repoRoot, '.icon-preview'),
  resolve(appDir, '.next'),
  resolve(appDir, '.open-next'),
  resolve(appDir, 'out'),
  resolve(appDir, 'coverage'),
  resolve(appDir, 'playwright-report'),
  resolve(appDir, 'test-results'),
  resolve(appDir, 'src-tauri/gen/android/app/build'),
  resolve(appDir, 'src-tauri/gen/apple/build'),
];

const formatBytes = (bytes) => {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
};

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const sizeOf = (path) => {
  const output = execFileSync('du', ['-sk', path], { encoding: 'utf8' });
  return Number.parseInt(output, 10) * 1024;
};

const freeBytes = async () => {
  const stats = await statfs(repoRoot, { bigint: true });
  return Number(stats.bavail * stats.bsize);
};

const showStatus = async () => {
  console.log(`Free disk space: ${formatBytes(await freeBytes())}`);
  let total = 0;
  for (const path of artifacts) {
    if (!(await exists(path))) continue;
    const bytes = sizeOf(path);
    total += bytes;
    console.log(`${formatBytes(bytes).padStart(10)}  ${path.slice(repoRoot.length + 1)}`);
  }
  console.log(`Bukshelf build artifacts: ${formatBytes(total)}`);
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0) {
    console.log('\nDocker usage:');
    execFileSync('docker', ['system', 'df'], { stdio: 'inherit' });
  }
};

const cleanArtifacts = async () => {
  for (const path of artifacts) {
    if (!(await exists(path))) continue;
    const bytes = sizeOf(path);
    console.log(`${dryRun ? 'Would remove' : 'Removing'} ${path} (${formatBytes(bytes)})`);
    if (!dryRun) await rm(path, { recursive: true, force: true });
  }
};

const cleanDocker = () => {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    console.log('Docker is unavailable; skipping Docker cache cleanup.');
    return;
  }
  const commands = [
    ['builder', 'prune', '--force', '--filter', 'until=168h'],
    ['image', 'prune', '--force'],
  ];
  for (const args of commands) {
    console.log(`${dryRun ? 'Would run' : 'Running'} docker ${args.join(' ')}`);
    if (!dryRun) execFileSync('docker', args, { stdio: 'inherit' });
  }
  console.log('Docker volumes are never removed by this command.');
};

if (!['status', 'guard', 'clean', 'docker'].includes(mode)) {
  console.error('Usage: storage-maintenance.mjs [status|guard|clean|docker] [--dry-run]');
  process.exit(2);
}

if (mode === 'status') {
  await showStatus();
} else if (mode === 'guard') {
  let available = await freeBytes();
  if (available < minimumFreeBytes) {
    console.log(
      `Only ${formatBytes(available)} is free; cleaning reproducible Bukshelf artifacts before the native build.`,
    );
    await cleanArtifacts();
    available = await freeBytes();
    if (available < minimumFreeBytes) {
      console.error(
        `Native builds require ${formatBytes(minimumFreeBytes)} free; cleanup left ${formatBytes(available)}.`,
      );
      process.exit(1);
    }
  }
  console.log(`Storage check passed: ${formatBytes(available)} free.`);
} else if (mode === 'clean') {
  await cleanArtifacts();
  if (!dryRun) await showStatus();
} else {
  cleanDocker();
}
