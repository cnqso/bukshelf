#!/usr/bin/env node

import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const identityPath = join(appDir, 'branding', 'native-identity.json');
const sourceRoots = [join(appDir, 'src-tauri'), join(appDir, 'src'), join(appDir, 'scripts')];
const textExtensions = new Set([
  '.gradle',
  '.entitlements',
  '.json',
  '.kt',
  '.kts',
  '.mjs',
  '.plist',
  '.pbxproj',
  '.properties',
  '.rs',
  '.sh',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.xml',
  '.yml',
]);
const ignoredDirectories = new Set(['build', 'DerivedData', 'target']);
const legacyBundleIdentifiers = ['com.bilingify.readest'];

const usage = `Usage: pnpm native:identity [options]

Options:
  --name <display name>       Visible app name
  --publisher <name>          Informational publisher/organization name
  --bundle-id <identifier>    Provisional native identifier
  --help                      Show this help

This command deliberately does not configure an Apple team or register an App ID.`;

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function validateIdentity(identity) {
  if (!identity.displayName.trim()) throw new Error('Display name cannot be empty');
  if (!identity.publisherName.trim()) throw new Error('Publisher name cannot be empty');
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+){2,}$/.test(identity.bundleIdentifier)) {
    throw new Error(
      'Bundle ID must be a lowercase reverse-domain identifier with at least three parts',
    );
  }
}

async function listTextFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTextFiles(path)));
    else if (
      (textExtensions.has(extname(entry.name)) || entry.name === 'Info.plist') &&
      !['configure-native-identity.mjs', 'test-native-identity.mjs'].includes(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function updateDisplayName(contents, previousName, nextName) {
  if (previousName === nextName) return contents;
  return contents
    .replaceAll(`"productName": "${previousName}"`, `"productName": "${nextName}"`)
    .replaceAll(`PRODUCT_NAME: ${previousName}`, `PRODUCT_NAME: ${nextName}`)
    .replaceAll(`CFBundleDisplayName: ${previousName}`, `CFBundleDisplayName: ${nextName}`);
}

function removeUpstreamSigning(contents) {
  return contents
    .replace(/^\s*\"developmentTeam\": \"J5W48D69VR\",?\r?\n/gm, '')
    .replace(/^\s*DEVELOPMENT_TEAM: J5W48D69VR\r?\n/gm, '')
    .replace(/^\s*DevelopmentTeam = J5W48D69VR;\r?\n/gm, '')
    .replace(/^\s*DEVELOPMENT_TEAM = J5W48D69VR;\r?\n/gm, '')
    .replaceAll('J5W48D69VR', '<APPLE_TEAM_ID>');
}

async function relocateAndroidSources(identifiers, nextIdentifier) {
  const changed = [];
  const androidSourceRoot = join(appDir, 'src-tauri', 'gen', 'android', 'app', 'src');
  const nextPackagePath = nextIdentifier.replaceAll('.', '/');

  for (const sourceSet of ['main', 'test', 'androidTest']) {
    const javaRoot = join(androidSourceRoot, sourceSet, 'java');
    const nextDirectory = join(javaRoot, nextPackagePath);
    for (const identifier of identifiers) {
      const previousDirectory = join(javaRoot, identifier.replaceAll('.', '/'));
      if (previousDirectory === nextDirectory) continue;
      try {
        await access(previousDirectory);
      } catch {
        continue;
      }
      try {
        await access(nextDirectory);
        throw new Error(
          `Cannot relocate Android package: both ${relative(appDir, previousDirectory)} and ${relative(appDir, nextDirectory)} exist`,
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await mkdir(dirname(nextDirectory), { recursive: true });
      await rename(previousDirectory, nextDirectory);
      changed.push(
        `${relative(appDir, previousDirectory)} -> ${relative(appDir, nextDirectory)}`,
      );
    }
  }
  return changed;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }

  const previous = JSON.parse(await readFile(identityPath, 'utf8'));
  const next = {
    ...previous,
    displayName: readOption(args, '--name') ?? previous.displayName,
    publisherName: readOption(args, '--publisher') ?? previous.publisherName,
    bundleIdentifier: readOption(args, '--bundle-id') ?? previous.bundleIdentifier,
    productionIdentifierReserved: false,
  };
  validateIdentity(next);

  const identifiers = new Set([previous.bundleIdentifier, ...legacyBundleIdentifiers]);
  const changed = await relocateAndroidSources(identifiers, next.bundleIdentifier);

  const files = [
    ...(await Promise.all(sourceRoots.map(listTextFiles))).flat(),
    join(appDir, '.env.tauri'),
    join(appDir, 'package.json'),
  ];
  for (const path of files) {
    let contents = await readFile(path, 'utf8');
    const before = contents;
    for (const identifier of identifiers) {
      contents = contents.replaceAll(identifier, next.bundleIdentifier);
    }
    contents = updateDisplayName(contents, previous.displayName, next.displayName);
    contents = removeUpstreamSigning(contents);
    if (contents !== before) {
      await writeFile(path, contents);
      changed.push(relative(appDir, path));
    }
  }

  await writeFile(identityPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `Native identity: ${next.displayName} (${next.bundleIdentifier}), publisher ${next.publisherName}`,
  );
  console.log(`Updated ${changed.length} file${changed.length === 1 ? '' : 's'}.`);
  console.log('Apple signing remains unconfigured; no App ID was registered.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
