#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const bundledXcode = '/Applications/Xcode.app/Contents/Developer';
const homebrewRustupBin = '/opt/homebrew/opt/rustup/bin';
const commandEnvironment = {
  ...process.env,
  ...(existsSync(homebrewRustupBin)
    ? { PATH: `${homebrewRustupBin}:${process.env.PATH || ''}` }
    : {}),
  ...(existsSync(bundledXcode) && !process.env.DEVELOPER_DIR
    ? { DEVELOPER_DIR: bundledXcode }
    : {}),
};

const checks = [
  { name: 'Rust compiler', command: 'rustc', args: ['--version'] },
  { name: 'Cargo', command: 'cargo', args: ['--version'] },
  { name: 'Full Xcode', command: 'xcodebuild', args: ['-version'] },
];

let failed = false;
for (const check of checks) {
  try {
    const output = execFileSync(check.command, check.args, {
      encoding: 'utf8',
      env: commandEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    console.log(`✓ ${check.name}: ${output.replaceAll('\n', ' / ')}`);
  } catch (error) {
    failed = true;
    const stderr = error?.stderr?.toString().trim();
    console.error(`✗ ${check.name}: ${stderr || `${check.command} is unavailable`}`);
  }
}

try {
  const installed = execFileSync('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
    env: commandEnvironment,
  });
  for (const target of ['aarch64-apple-ios', 'aarch64-apple-ios-sim']) {
    if (installed.split(/\s+/).includes(target)) console.log(`✓ Rust target: ${target}`);
    else {
      failed = true;
      console.error(`✗ Rust target: ${target} (run: rustup target add ${target})`);
    }
  }
} catch {
  failed = true;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.warn(`! Expected an Apple-silicon Mac; found ${process.platform}/${process.arch}`);
}

if (failed) {
  console.error('\nNative iOS prerequisites are incomplete.');
  process.exitCode = 1;
} else {
  console.log('\nNative iOS prerequisites are ready.');
}
