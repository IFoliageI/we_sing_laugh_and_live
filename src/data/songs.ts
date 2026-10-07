// ============================================================
//  歌单数据（渺の歌单 / 页面网址 /request）
//
//  ★ 数据已经迁移到 SQLite，本文件【不再手写内容】！
//    内容源：data/content.db（section = 'song'）
//    生成物：src/data/content.json（由 scripts/content-sync.mjs 自动生成）
//
//  改内容的方式同首页，见 src/data/voices.ts 顶部说明。
// ============================================================
import content from './content.json';
import type { Voice, VoiceGroup } from './voices';

/**
 * 歌单分组。
 * 每条歌曲的字段含义：
 *   path   = 音频路径（相对 public/audio，例如 'songs/歌名.mp3'）
 *   zh     = 按钮上显示的文字（歌名）
 *   artist = 原唱作者（歌单页切到「原唱作者」展示方式时按它分组）
 *   info   = 悬停卡片信息：time=时间、title=标题/出处、note=备注、thumb=缩略图
 */
export const songGroups = content.song.groups as unknown as VoiceGroup[];

// 把所有歌曲按「原唱作者」重新分组（歌单页切换到「原唱作者」展示方式时使用）。
// 同一作者的歌会归到一个分组里；没填 artist 的归到「未知作者」。
export function groupSongsByArtist(groups: VoiceGroup[]): VoiceGroup[] {
  const map = new Map<string, Voice[]>();
  for (const g of groups) {
    for (const v of g.voices) {
      const key = (v.artist ?? '').trim() || '未知作者';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(v);
    }
  }
  return Array.from(map.entries()).map(([artist, voices], i) => ({
    groupName: `artist_${i}`,
    title: artist,
    voices,
  }));
}

// 歌单随机播放时「一首歌都没有」的提示文案（数据库 settings 表可改）
export const SONG_EMPTY_HINT = content.song.hint;
