/**
 * 站点内资源地址工具。
 *
 * 部署到子路径时（GitHub Pages 项目页 /<仓库名>/、Cloudflare Pages 子目录），
 * 站点根路径不再是域名根，所有「以 / 开头」的站内绝对路径都要补上部署基路径。
 * 基路径由 astro.config.mjs 的 `base` 经 Vite 注入到 import.meta.env.BASE_URL：
 *   - 根路径部署（不设 SITE_BASE）：'/'      → 前缀 ''
 *   - 子路径部署：'/repo/'                    → 前缀 '/repo'
 */

/**
 * 读取当前部署基路径。
 * 构建/开发时由 Vite 静态替换 import.meta.env.BASE_URL；
 * Node 直接运行（tests 会 import src/lib/media.ts，从而加载本文件）时没有 import.meta.env，
 * 这里回退到根路径，保证单元测试与「不设 SITE_BASE」时的行为完全一致。
 */
function readBaseUrl(): string {
  try {
    return import.meta.env.BASE_URL;
  } catch {
    return '/';
  }
}

/** 部署基路径前缀（不含末尾斜杠）：根路径部署为空串，子路径部署如 '/repo'。 */
export const basePrefix: string = (readBaseUrl() || '/').replace(/\/+$/, '');

/**
 * 把站内资源路径拼上部署基路径。
 * 完整 http(s) 直链、协议相对地址（//host/...）与空串原样返回，避免二次编码或破坏签名参数。
 */
export function assetUrl(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//i.test(path) || path.startsWith('//')) return path;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${basePrefix}${normalized}`;
}
