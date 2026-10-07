// 「渺の歌单」页面的歌曲数据。
// 结构和首页的 src/data/voices.ts 完全一样（复用同一套类型），只是内容换成歌曲。
//   path   = 音频路径（相对 public/audio，例如 'songs/歌名.mp3' 对应 public/audio/songs/歌名.mp3）
//   zh     = 按钮上显示的文字（歌名）
//   artist = 原唱作者（歌单页切到「原唱作者」展示方式时按它分组）
//   info   = 悬停卡片信息：time=时间、title=标题/出处、note=备注、thumb=缩略图（均可留空）
// 复制一条即可增加歌曲，删掉一条即可移除。
import type { Voice, VoiceGroup } from './voices';

export const songGroups: VoiceGroup[] = [
  {
    groupName: 'song_acg',
    title: 'ACG',
    voices: [
      {
        path: 'songs/翻唱_示例1.mp3',
        zh: '示例：翻唱曲目（改成歌名）',
        artist: '示例歌手 A',
        info: {
          time: '2024年5月1日 20:00',
          title: '原曲：《示例一》',
          thumb: '/thumbs/placeholder.svg',
        },
      },
      {
        path: 'songs/翻唱_示例2.mp3',
        zh: '示例：翻唱曲目二（改成歌名）',
        artist: '示例歌手 B',
        info: {
          time: '2024年5月2日 21:30',
          title: '原曲：《示例二》',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
  },
  {
    groupName: 'song_folk',
    title: '民谣',
    voices: [
      {
        path: 'songs/原创_示例1.mp3',
        zh: '示例：原创曲目（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月1日 19:00',
          title: '原创 · 第一首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
      {
        path: 'songs/原创_示例2.mp3',
        zh: '示例：原创曲目二（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月2日 19:00',
          title: '原创 · 第二首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
  },
  {
    groupName: 'song_rock',
    title: '摇滚',
    voices: [
      {
        path: 'songs/原创_示例1.mp3',
        zh: '示例：原创曲目（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月1日 19:00',
          title: '原创 · 第一首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
      {
        path: 'songs/原创_示例2.mp3',
        zh: '示例：原创曲目二（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月2日 19:00',
          title: '原创 · 第二首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
  },
  {
    groupName: 'song_pop',
    title: '流行',
    voices: [
      {
        path: 'songs/原创_示例1.mp3',
        zh: '示例：原创曲目（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月1日 19:00',
          title: '原创 · 第一首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
      {
        path: 'songs/原创_示例2.mp3',
        zh: '示例：原创曲目二（改成歌名）',
        artist: '渺渺渺',
        info: {
          time: '2024年6月2日 19:00',
          title: '原创 · 第二首',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
  },  
];

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

// 歌单随机播放时「一首歌都没有」的提示文案
export const SONG_EMPTY_HINT = '还没有歌曲哦，等主人有空放进 public/audio/songs 就能听啦';
