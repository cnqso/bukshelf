#!/usr/bin/env node
import { buildIconSet, parseIconArgs } from './icon-pipeline.mjs';

const usage = `Usage:
  pnpm icons:preview -- <image> [--fit contain|cover] [--background <color>]
  pnpm icons:apply -- <image> [--fit contain|cover] [--background <color>]`;

try {
  const options = parseIconArgs(process.argv.slice(2));
  const result = await buildIconSet(options.source, options);
  const { width, height } = result.metadata;
  console.log(`${options.mode === 'preview' ? 'Previewed' : 'Applied'} ${width}x${height} source`);
  console.log(result.destination);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(usage);
  process.exitCode = 1;
}
