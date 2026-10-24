import { defineConfig } from 'astro/config';
import solidJs from '@astrojs/solid-js';
import { publicMediaPlugin } from './scripts/lib/public-media-plugin.mjs';

// 部署相关环境变量（都可以不设；不设时保持根路径部署的现有行为）：
//   SITE_URL  站点完整地址，写入 Astro 的 site，用于生成绝对 URL / SEO 信息
//   SITE_BASE 子路径部署的基路径，写入 Astro 的 base（GitHub Pages 项目页 /<仓库名>/、
//             Cloudflare Pages 子目录 /music/ 之类的场景）
// 示例：
//   根路径部署（Cloudflare Pages / nginx / 自定义域名）：什么都不用设，或只设
//     SITE_URL=https://example.com pnpm build
//   GitHub Pages 项目页（https://<owner>.github.io/<repo>/）：
//     SITE_BASE=/<repo>/ SITE_URL=https://<owner>.github.io/<repo> pnpm build
const site = process.env.SITE_URL?.trim() || '';
const rawBase = process.env.SITE_BASE?.trim() || '';
// 规范成以 / 开头、以 / 结尾（与 Astro 自身的 base 规范化一致，渲染端再统一去掉末尾斜杠）；
// 纯根路径（'/'）按未设置处理，避免产生一个与默认值等价的 base 键。
const normalizedBase = rawBase.replace(/^\/+|\/+$/g, '');
const base = normalizedBase ? `/${normalizedBase}/` : '';

// https://astro.build/config
export default defineConfig({
  // 条件展开：未设置对应环境变量时不产生 site / base 键，构建结果与改造前完全一致
  ...(site ? { site } : {}),
  ...(base ? { base } : {}),
  integrations: [solidJs()],
  output: 'static',
  devToolbar: { enabled: false },
  vite: { plugins: [publicMediaPlugin()] },
});
