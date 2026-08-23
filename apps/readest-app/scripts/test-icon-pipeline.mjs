import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createMasterIcon, generateWebIcons, parseIconArgs } from './icon-pipeline.mjs';

test('requires an explicit safe mode and validates fit', () => {
  assert.throws(() => parseIconArgs(['art.jpg']), /--preview or --apply/);
  assert.throws(() => parseIconArgs(['art.jpg', '--preview', '--fit', 'stretch']), /contain or cover/);
  assert.deepEqual(parseIconArgs(['art.jpg', '--apply']), {
    mode: 'apply',
    fit: 'cover',
    background: '#f7f5f0',
    source: 'art.jpg',
  });
  assert.equal(parseIconArgs(['--preview', '--', 'art.jpg']).source, 'art.jpg');
});

test('normalizes portrait artwork and generates exact web icon sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bukshelf-icon-test-'));
  try {
    const source = join(directory, 'portrait.png');
    const master = join(directory, 'master.png');
    const web = join(directory, 'web');
    await sharp({ create: { width: 200, height: 400, channels: 3, background: '#ff0000' } })
      .png()
      .toFile(source);

    await createMasterIcon(source, master, { fit: 'cover', background: '#ffffff' });
    await generateWebIcons(master, web);

    assert.deepEqual(await sharp(master).metadata().then(({ width, height }) => ({ width, height })), {
      width: 1024,
      height: 1024,
    });
    for (const [name, size] of [
      ['icon.png', 512],
      ['icon-512.png', 512],
      ['icon-192.png', 192],
      ['apple-touch-icon.png', 180],
      ['icon-tiny.png', 128],
    ]) {
      const metadata = await sharp(join(web, name)).metadata();
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
