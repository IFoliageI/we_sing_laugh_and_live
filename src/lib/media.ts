import { media } from '../data/media.ts';
import { resolveMediaUrl } from './media-url.mjs';

export function audioUrl(path: string, baseUrl: string = media.audioBaseUrl): string {
  return resolveMediaUrl(path, baseUrl, '/audio');
}

export function imageUrl(path: string, baseUrl: string = media.imageBaseUrl): string {
  return resolveMediaUrl(path, baseUrl, '', true);
}
