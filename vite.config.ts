import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/** The dev API server binds 127.0.0.1; "localhost" may resolve to ::1 first on Node 22. */
const API_TARGET = 'http://127.0.0.1:8739';

/**
 * Files the dev server must never serve through /@fs/. Setting server.fs.deny replaces Vite's defaults, so they are
 * repeated first (vite 8.3.0). A pattern without "/" matches a file name at any depth; that keeps the rule independent
 * of where the repository is checked out, and it covers the dev database (data/), the E2E data (.e2e-data/) and the
 * SQLite WAL and SHM files next to each database.
 */
const DEV_SERVER_DENY = [
  '.env',
  '.env.*',
  '*.{crt,pem,key,p12,pfx,cer,der}',
  '.npmrc',
  '.yarnrc.yml',
  '**/.git/**',
  '*.db',
  '*.db-*',
  '*.jsonl',
];

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  // Svelte 5 compiles lang="ts" natively, so there is no svelte.config.js to look for (and no info line about it).
  plugins: [svelte({ configFile: false })],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // Maps are still written for local debugging, but no bundle points at them, and the Docker image drops them.
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 1024,
    // Vite's default 4096-byte threshold inlines the smallest @fontsource subsets as data: URIs,
    // which violates the frozen CSP (font-src 'self', no data:). Every font subset must stay a
    // fetched file so the browser downloads only the subsets a page's unicode-range actually needs.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': API_TARGET, '/healthz': API_TARGET },
    fs: { deny: DEV_SERVER_DENY },
  },
});
