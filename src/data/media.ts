import { normalizeMediaBaseUrl } from '../lib/media-url.mjs';

// 空值保持本地资源；基础地址必须含资源目录，例如 https://cdn.example.com/audio。
export const media = {
  audioBaseUrl: normalizeMediaBaseUrl(import.meta.env?.PUBLIC_AUDIO_BASE_URL ?? ''),
  imageBaseUrl: normalizeMediaBaseUrl(import.meta.env?.PUBLIC_IMAGE_BASE_URL ?? ''),
};
