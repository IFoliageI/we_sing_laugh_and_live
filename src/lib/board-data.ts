import type { Voice, VoiceGroup } from '../data/voices.ts';
export { audioUrl } from './media.ts';

export function normalVoices(group: VoiceGroup): Voice[] {
  return [...group.voices, ...(group.stacks ?? []).flatMap((stack) => stack.voices)];
}

export function findVoice(groups: VoiceGroup[], path: string) {
  for (const group of groups) {
    const voice = normalVoices(group).find((item) => item.path === path);
    if (voice) return { voice, groupName: group.groupName };
  }
  return null;
}

export function shareUrl(pageUrl: string, voice: Pick<Voice, 'path' | 'zh'>): string {
  const url = new URL(pageUrl);
  url.hash = '';
  url.search = '';
  url.searchParams.set('btn', voice.path);
  url.searchParams.set('name', voice.zh);
  return url.href;
}

/** 作者视图包含合集成员，并合并同作者下跨分类重复的音频。 */
export function groupSongsByArtist(groups: VoiceGroup[]): VoiceGroup[] {
  const artists = new Map<string, Map<string, Voice>>();
  for (const group of groups) {
    for (const voice of normalVoices(group)) {
      const artist = voice.artist?.trim() || '未知作者';
      if (!artists.has(artist)) artists.set(artist, new Map());
      const voices = artists.get(artist)!;
      if (!voices.has(voice.path)) voices.set(voice.path, voice);
    }
  }
  return Array.from(artists, ([artist, voices]) => ({
    groupName: `artist_${encodeURIComponent(artist)}`,
    title: artist,
    voices: Array.from(voices.values()),
  }));
}
