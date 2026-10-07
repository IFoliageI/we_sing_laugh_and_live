import { defineConfig } from 'astro/config';
import solidJs from '@astrojs/solid-js';

// https://astro.build/config
export default defineConfig({
  integrations: [solidJs()],
  output: 'static',
  // 如需生成带绝对 URL 的 SEO 资源，请在下方填入正式域名
});