import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://www.veeessknits.com',
  output: 'static',
  outDir: './dist',
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'never' },
  // Keep every script in its own file so the Content-Security-Policy can
  // forbid inline scripts entirely.
  vite: { build: { assetsInlineLimit: 0 } },
  devToolbar: { enabled: false },
});
