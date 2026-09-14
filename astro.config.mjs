// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  devToolbar: { enabled: false },
  site: 'https://droparabia.com',
  output: 'static',
  redirects: {
    '/get-free-program': '/the-ultimate-copy-program',
  },
  adapter: cloudflare(),
  integrations: [react()],
  build: {
    inlineStylesheets: 'always',
  },
});
