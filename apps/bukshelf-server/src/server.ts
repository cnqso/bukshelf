import { createHandler } from './app';

const port = Number.parseInt(process.env.BUKSHELF_PORT ?? '43175', 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid BUKSHELF_PORT: ${process.env.BUKSHELF_PORT}`);
}

const server = Bun.serve({
  hostname: process.env.BUKSHELF_HOST ?? '127.0.0.1',
  port,
  fetch: createHandler({ webDir: process.env.BUKSHELF_WEB_DIR }),
});

console.log(`Bukshelf migration server listening on ${server.url}`);
