import { media } from '../data/media.ts';
import { basePrefix } from './asset-url.ts';
import { resolveMediaUrl } from './media-url.mjs';

// 本地资源前缀由 Vite 注入的部署基路径拼出（根部署时 basePrefix 为 ''）：
//   audioUrl：/audio          → 子路径部署时 /<base>/audio
//   imageUrl：''（public 根） → 子路径部署时 /<base>
// 未配置 PUBLIC_*_BASE_URL 时才会用到这些前缀；配置了远端基础地址则原样走远端，行为不变。
export function audioUrl(path: string, baseUrl: string = media.audioBaseUrl): string {
  return resolveMediaUrl(path, baseUrl, `${basePrefix}/audio`);
}

export function imageUrl(path: string, baseUrl: string = media.imageBaseUrl): string {
  return resolveMediaUrl(path, baseUrl, basePrefix, true);
}
