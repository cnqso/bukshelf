import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const appDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const identity = JSON.parse(
  await readFile(join(appDir, 'branding', 'native-identity.json'), 'utf8'),
);

const read = (path) => readFile(join(appDir, path), 'utf8');

test('native identity is provisional and internally consistent', async () => {
  assert.equal(identity.publisherName, 'Katamado');
  assert.equal(identity.productionIdentifierReserved, false);
  assert.match(identity.bundleIdentifier, /^com\.katamado\..+\.dev$/);

  const [tauriConfig, androidConfig, appleProject, env] = await Promise.all([
    read('src-tauri/tauri.conf.json'),
    read('src-tauri/gen/android/app/build.gradle.kts'),
    read('src-tauri/gen/apple/project.yml'),
    read('.env.tauri'),
  ]);

  for (const contents of [tauriConfig, androidConfig, appleProject, env]) {
    assert.match(contents, new RegExp(identity.bundleIdentifier.replaceAll('.', '\\.')));
    assert.doesNotMatch(contents, /com\.bilingify\.readest/);
    assert.doesNotMatch(contents, /J5W48D69VR/);
  }
  assert.match(tauriConfig, new RegExp(`"productName": "${identity.displayName}"`));
  assert.doesNotMatch(tauriConfig, /developmentTeam/);
});

test('canonical and generated iOS metadata contain required bundle keys', async () => {
  const [canonical, generated] = await Promise.all([
    read('src-tauri/Info-ios.plist'),
    read('src-tauri/gen/apple/Readest_iOS/Info.plist'),
  ]);
  for (const plist of [canonical, generated]) {
    for (const key of [
      'CFBundleExecutable',
      'CFBundleIdentifier',
      'CFBundleInfoDictionaryVersion',
      'CFBundlePackageType',
      'CFBundleShortVersionString',
      'CFBundleVersion',
      'UILaunchStoryboardName',
    ]) {
      assert.match(plist, new RegExp(`<key>${key}</key>`));
    }
  }
});
