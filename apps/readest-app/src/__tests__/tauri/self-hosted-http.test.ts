import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');

describe('self-hosted HTTP transport', () => {
  it('allows HTTP API requests through the Tauri content policy', () => {
    const config = read('src-tauri/tauri.conf.json');
    expect(config).toContain('http://*:*');
  });

  it('allows cleartext traffic in Android release builds', () => {
    const gradle = read('src-tauri/gen/android/app/build.gradle.kts');
    expect(gradle).toContain('manifestPlaceholders["usesCleartextTraffic"] = "true"');
    expect(gradle).not.toContain('manifestPlaceholders["usesCleartextTraffic"] = "false"');
  });

  it('allows HTTP from the iOS webview', () => {
    const plist = read('src-tauri/Info-ios.plist');
    expect(plist).toContain('<key>NSAllowsArbitraryLoadsInWebContent</key>');
    expect(plist).toMatch(/NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/);
  });
});
