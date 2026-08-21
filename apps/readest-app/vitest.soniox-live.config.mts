import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  define: { 'process.env': '{}' },
  resolve: {
    alias: { '@pdfjs': resolve(import.meta.dirname, 'public/vendor/pdfjs') },
  },
  optimizeDeps: {
    include: [
      '@tauri-apps/api/core',
      '@tauri-apps/api/path',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-http',
      '@tauri-apps/plugin-websocket',
      'franc-min',
      'iso-639-2',
      'iso-639-3',
      'isomorphic-ws',
      'js-md5',
      'jwt-decode',
    ],
    exclude: ['@pdfjs/pdf.min.mjs'],
  },
  server: { host: '127.0.0.1', port: 43_283, strictPort: true },
  test: {
    include: ['src/__tests__/services/soniox-playback.live.browser.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
