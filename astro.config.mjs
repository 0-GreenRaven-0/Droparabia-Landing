// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  devToolbar: { enabled: false },
  site: 'https://droparabia.com',
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
});
