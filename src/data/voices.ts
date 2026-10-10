// ============================================================
//  声音数据结构 + 首页数据（渺の怪动静）
//
//  ★ 数据已经迁移到 SQLite，本文件【不再手写内容】！
//    内容源：data/content.db
//    生成物：src/data/content.json（由 scripts/content-sync.mjs 自动生成）
//
//  怎么改内容：
//      pnpm content:add          添加条目（命令行）
//      pnpm content:list         查看现有条目
//      pnpm content:stats        每个分组的条目统计
//      pnpm content:sync         手改数据库后重新生成 JSON
//    （pnpm build / pnpm dev 都会自动先跑一次 sync，不用手动执行）
//
//   也可以用 DB Browser for SQLite 之类的图形工具直接编辑 data/content.db。
// ============================================================
import content from './content.json';

// 悬停卡片信息（鼠标移到按钮上显示）
export interface VoiceInfo {
  // 时间，如「2024年3月15日 21:30」
  time?: string;
  // 标题，如「半夜唱歌」
  title?: string;
  // 其他备注（可选）
  note?: string;
  // 缩略图：public 路径（如 /thumbs/xxx.png）或 HTTP(S) 图床直链；不填则不显示
  thumb?: string;
}

export interface Voice {
  // 音频：相对 public/audio 的路径，或完整 HTTP(S) OSS/CDN 直链
  path: string;
  // 按钮上显示的文字
  zh: string;
  // 原唱作者（「渺の歌单」可按它分组；音效类可留空）
  artist?: string;
  // 悬停卡片信息
  info?: VoiceInfo;
}

// 堆叠按钮（合集）：一个按钮对应多个音频。
// 单击随机播放其中一个；双击随机换一个当前项；鼠标悬停显示当前项信息 + 第 x/x 个。
export interface VoiceStack {
  // 合集标题（显示在堆叠按钮上），缺省显示「合集」
  title?: string;
  // 合集中的多个音频
  voices: Voice[];
}

export interface VoiceGroup {
  // 分组 id（用于锚点 / URL）
  groupName: string;
  // 分组显示标题
  title: string;
  // 该组的声音按钮列表
  voices: Voice[];
  // 该组的堆叠按钮（合集）
  stacks?: VoiceStack[];
  // 隐藏音频（彩蛋“往日”开启后才显示；不参与随机，也不会因 URL 直链被自动播放）
  hiddenVoices?: Voice[];
}

// ---------- 以下是自动生成的数据，请勿手工编辑（改 data/content.db） ----------

/** 首页分组（数据库里 section = 'voice' 且 is_secret = 0 的分组） */
export const voiceGroups = content.voice.groups as VoiceGroup[];

/** 彩蛋分组：仅当“往日”开关打开时出现在首页底部 */
export const secretGroup = (content.voice.secretGroup ?? {
  groupName: 'forgotten',
  title: '往日',
  voices: [],
}) as VoiceGroup;

/** 随机播放下限守卫：无内容时给出提示文案（数据库 settings 表可改） */
export const EMPTY_HINT = content.voice.hint;

// ---------- 彩蛋相关键名（这是代码常量，不是内容，故留在代码里） ----------

/** 连点主题切换按钮解锁彩蛋的标记位 */
export const EG_UNLOCK_KEY = 'lmy-easter-unlock'; // '1' = 已被连点解锁
/** 「往日」开关状态 */
export const PAST_KEY = 'lmy-past'; // '1' = 打开“往日”开关
