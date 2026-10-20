import { defineConfig } from 'astro/config';
import solidJs from '@astrojs/solid-js';
import { publicMediaPlugin } from './scripts/lib/public-media-plugin.mjs';

// https://astro.build/config
export default defineConfig({
  integrations: [solidJs()],
  output: 'static',
  devToolbar: { enabled: false },
  vite: { plugins: [publicMediaPlugin()] },
  // 如需生成带绝对 URL 的 SEO 资源，请在下方填入正式域名
});
