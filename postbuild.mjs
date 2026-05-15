import { cpSync, writeFileSync } from 'node:fs';

// Copy pre-rendered HTML/assets to dist root so Cloudflare Pages serves them directly
cpSync('dist/client', 'dist', { recursive: true });

// Create _worker.js shim — this activates Cloudflare Pages Advanced Mode
// Cloudflare serves static files before calling the worker, so this only
// handles truly dynamic routes (e.g. /api/subscribe)
writeFileSync('dist/_worker.js', `export { default } from './server/entry.mjs';\n`);

console.log('[postbuild] dist/ ready for Cloudflare Pages (Advanced Mode)');
