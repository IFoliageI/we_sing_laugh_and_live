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
import type { VoiceGroup } from './voices';
export { groupSongsByArtist } from '../lib/board-data';

/**
 * 歌单分组。
 * 每条歌曲的字段含义：
 *   path   = 音频路径（相对 public/audio，例如 'songs/歌名.mp3'）
 *   zh     = 按钮上显示的文字（歌名）
 *   artist = 原唱作者（歌单页切到「原唱作者」展示方式时按它分组）
 *   info   = 悬停卡片信息：time=时间、title=标题/出处、note=备注、thumb=缩略图
 */
export const songGroups = content.song.groups as VoiceGroup[];

// 歌单随机播放时「一首歌都没有」的提示文案（数据库 settings 表可改）
export const SONG_EMPTY_HINT = content.song.hint;
