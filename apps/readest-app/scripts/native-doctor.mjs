#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const bundledXcode = '/Applications/Xcode.app/Contents/Developer';
const homebrewRustupBin = '/opt/homebrew/opt/rustup/bin';
const homebrewJavaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
const homebrewAndroidHome = '/opt/homebrew/share/android-commandlinetools';
const requestedPlatform = process.argv.includes('--android') ? 'android' : 'ios';
const javaHome = process.env.JAVA_HOME || (existsSync(homebrewJavaHome) ? homebrewJavaHome : '');
const androidHome =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (existsSync(homebrewAndroidHome) ? homebrewAndroidHome : '');
const commandEnvironment = {
  ...process.env,
  ...(existsSync(homebrewRustupBin)
    ? { PATH: `${homebrewRustupBin}:${process.env.PATH || ''}` }
    : {}),
  ...(javaHome
    ? {
        JAVA_HOME: javaHome,
        PATH: `${javaHome}/bin:${homebrewRustupBin}:${process.env.PATH || ''}`,
      }
    : {}),
  ...(androidHome ? { ANDROID_HOME: androidHome } : {}),
  ...(existsSync(bundledXcode) && !process.env.DEVELOPER_DIR
    ? { DEVELOPER_DIR: bundledXcode }
    : {}),
};

const iosChecks = [
  { name: 'Rust compiler', command: 'rustc', args: ['--version'] },
  { name: 'Cargo', command: 'cargo', args: ['--version'] },
  { name: 'Full Xcode', command: 'xcodebuild', args: ['-version'] },
];
const androidChecks = [
  { name: 'Rust compiler', command: 'rustc', args: ['--version'] },
  { name: 'Cargo', command: 'cargo', args: ['--version'] },
  { name: 'Java', command: 'java', args: ['--version'] },
  { name: 'Android SDK manager', command: 'sdkmanager', args: ['--version'] },
  { name: 'Android device bridge', command: 'adb', args: ['version'] },
];
const checks = requestedPlatform === 'ios' ? iosChecks : androidChecks;

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
  const targets =
    requestedPlatform === 'ios'
      ? ['aarch64-apple-ios', 'aarch64-apple-ios-sim']
      : [
          'aarch64-linux-android',
          'armv7-linux-androideabi',
          'i686-linux-android',
          'x86_64-linux-android',
        ];
  for (const target of targets) {
    if (installed.split(/\s+/).includes(target)) console.log(`✓ Rust target: ${target}`);
    else {
      failed = true;
      console.error(`✗ Rust target: ${target} (run: rustup target add ${target})`);
    }
  }
} catch {
  failed = true;
}

if (requestedPlatform !== 'android' && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
  console.warn(`! Expected an Apple-silicon Mac; found ${process.platform}/${process.arch}`);
}

if (requestedPlatform !== 'ios') {
  if (!androidHome) {
    failed = true;
    console.error('✗ Android SDK root: set ANDROID_HOME');
  } else {
    console.log(`✓ Android SDK root: ${androidHome}`);
    for (const [name, relativePath, installName] of [
      ['Android 36 platform', 'platforms/android-36', 'platforms;android-36'],
      ['Android NDK', 'ndk/29.0.13846066', 'ndk;29.0.13846066'],
      ['Android platform tools', 'platform-tools', 'platform-tools'],
    ]) {
      if (existsSync(`${androidHome}/${relativePath}`)) console.log(`✓ ${name}`);
      else {
        failed = true;
        console.error(`✗ ${name} (run: sdkmanager '${installName}')`);
      }
    }
  }
}

const platformLabel = requestedPlatform === 'android' ? 'Android' : 'iOS';
if (failed) {
  console.error(`\nNative ${platformLabel} prerequisites are incomplete.`);
  process.exitCode = 1;
} else {
  console.log(`\nNative ${platformLabel} prerequisites are ready.`);
}
