import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(scriptDir, '..');
export const repoDir = resolve(appDir, '../..');
export const previewRoot = join(repoDir, '.icon-preview');

const VALID_FITS = new Set(['contain', 'cover']);

export function parseIconArgs(argv) {
  const options = {
    mode: undefined,
    fit: 'cover',
    background: '#f7f5f0',
    source: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--preview' || value === '--apply') {
      options.mode = value.slice(2);
    } else if (value === '--fit') {
      options.fit = argv[++index];
    } else if (value === '--background') {
      options.background = argv[++index];
    } else if (value !== '--' && !value?.startsWith('--') && !options.source) {
      options.source = value;
    } else if (value !== '--') {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!options.source) throw new Error('Provide an input image.');
  if (!options.mode) throw new Error('Choose either --preview or --apply.');
  if (!VALID_FITS.has(options.fit)) throw new Error('--fit must be contain or cover.');
  if (!options.background) throw new Error('--background requires a CSS color.');
  return options;
}

export async function createMasterIcon(source, destination, options) {
  const image = sharp(source, { failOn: 'warning' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('The input is not a readable image.');

  await mkdir(dirname(destination), { recursive: true });
  await image
    .rotate()
    .resize(1024, 1024, {
      fit: options.fit,
      position: 'centre',
      background: options.background,
    })
    .flatten({ background: options.background })
    .png()
    .toFile(destination);

  return metadata;
}

export async function generateWebIcons(master, destination) {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    sharp(master).resize(512, 512).png().toFile(join(destination, 'icon.png')),
    sharp(master).resize(512, 512).png().toFile(join(destination, 'icon-512.png')),
    sharp(master).resize(192, 192).png().toFile(join(destination, 'icon-192.png')),
    sharp(master).resize(180, 180).png().toFile(join(destination, 'apple-touch-icon.png')),
    sharp(master).resize(128, 128).png().toFile(join(destination, 'icon-tiny.png')),
  ]);
}

const WEB_ICON_NAMES = [
  'icon.png',
  'icon-512.png',
  'icon-192.png',
  'apple-touch-icon.png',
  'icon-tiny.png',
];

const runTauriIcon = (master, destination) =>
  new Promise((resolvePromise, reject) => {
    const args = ['exec', 'tauri', 'icon', master];
    if (destination) args.push('--output', destination);
    const child = spawn('pnpm', args, {
      cwd: appDir,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`tauri icon exited with code ${code}`));
    });
  });

const safeName = (source) =>
  basename(source, extname(source))
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '') || 'icon';

export async function buildIconSet(source, options) {
  const absoluteSource = resolve(source);
  const staging = await mkdtemp(join(tmpdir(), 'bukshelf-icons-'));
  const master = join(staging, 'icon-source.png');
  const native = join(staging, 'native');
  const web = join(staging, 'web');
  const monochrome = join(staging, 'android-monochrome.svg');
  const manifest = join(staging, 'icon-manifest.json');

  try {
    const metadata = await createMasterIcon(absoluteSource, master, options);
    await cp(join(appDir, 'branding/android-monochrome.svg'), monochrome);
    await writeFile(
      manifest,
      JSON.stringify({
        default: 'icon-source.png',
        bg_color: options.background,
        android_monochrome: 'android-monochrome.svg',
      }),
    );
    await Promise.all([generateWebIcons(master, web), runTauriIcon(manifest, native)]);

    if (options.mode === 'preview') {
      const destination = join(previewRoot, `${safeName(absoluteSource)}-${options.fit}`);
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await cp(master, join(destination, 'icon-source.png'));
      await cp(web, join(destination, 'web'), { recursive: true });
      await cp(native, join(destination, 'native'), { recursive: true });
      return { destination, metadata };
    }

    await mkdir(join(appDir, 'branding'), { recursive: true });
    await cp(master, join(appDir, 'branding/icon-source.png'));
    await Promise.all(
      WEB_ICON_NAMES.map((name) => cp(join(web, name), join(appDir, 'public', name))),
    );
    await cp(join(native, 'icon.ico'), join(appDir, 'public/favicon.ico'));
    await rm(join(appDir, 'src-tauri/icons'), { recursive: true, force: true });
    // Running with Tauri's default output updates both src-tauri/icons and any
    // initialized iOS/Android project asset catalogs.
    await runTauriIcon(manifest);
    // The default command updates initialized Android projects but omits the
    // portable icons/android source tree, so retain the complete staged set too.
    await cp(native, join(appDir, 'src-tauri/icons'), { recursive: true, force: true });
    return { destination: appDir, metadata };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
