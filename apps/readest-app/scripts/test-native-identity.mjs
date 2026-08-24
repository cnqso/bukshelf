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

  const androidPackagePath = identity.bundleIdentifier.replaceAll('.', '/');
  const [tauriConfig, androidConfig, androidActivity, appleProject, env] = await Promise.all([
    read('src-tauri/tauri.conf.json'),
    read('src-tauri/gen/android/app/build.gradle.kts'),
    read(`src-tauri/gen/android/app/src/main/java/${androidPackagePath}/MainActivity.kt`),
    read('src-tauri/gen/apple/project.yml'),
    read('.env.tauri'),
  ]);

  for (const contents of [tauriConfig, androidConfig, androidActivity, appleProject, env]) {
    assert.match(contents, new RegExp(identity.bundleIdentifier.replaceAll('.', '\\.')));
    assert.doesNotMatch(contents, /com\.bilingify\.readest/);
    assert.doesNotMatch(contents, /J5W48D69VR/);
  }
  assert.match(tauriConfig, new RegExp(`"productName": "${identity.displayName}"`));
  assert.doesNotMatch(tauriConfig, /developmentTeam/);
  await assert.rejects(
    read('src-tauri/gen/android/app/src/main/java/com/bilingify/readest/MainActivity.kt'),
    { code: 'ENOENT' },
  );
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

test('iOS extensions use the same versions as the app', async () => {
  const [app, shareExtension, appleProject] = await Promise.all([
    read('src-tauri/gen/apple/Readest_iOS/Info.plist'),
    read('src-tauri/gen/apple/ShareExtension/Info.plist'),
    read('src-tauri/gen/apple/project.yml'),
  ]);
  const plistValue = (plist, key) =>
    plist.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`))?.[1];

  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const appValue = plistValue(app, key);
    assert.equal(plistValue(shareExtension, key), appValue);
    assert.equal(
      appleProject.match(new RegExp(`${key}: ${appValue}`, 'g'))?.length,
      2,
      `both iOS extensions should declare ${key}: ${appValue}`,
    );
  }
});
