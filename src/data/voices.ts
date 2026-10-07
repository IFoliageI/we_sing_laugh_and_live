// 声音分组数据。
// path 相对 public/audio 目录。若要加入真实音档，把 mp3 放进 public/audio/<group>/ 并在下方填写 path 与 description。
export interface VoiceInfo {
  // 时间，如「2024年3月15日 21:30」
  time?: string;
  // 标题，如「半夜唱歌」
  title?: string;
  // 其他备注（可选）
  note?: string;
  // 缩略图地址：相对 public 的路径（如 /thumbs/xxx.png）或完整 URL；不填则不显示缩略图
  thumb?: string;
}

export interface Voice {
  // 音频相对 public/audio 的路径，如 crylx/啊.mp3
  path: string;
  // 按钮上显示的文字
  zh: string;
  // 原唱作者（「渺の歌单」可按它分组；音效类可留空）
  artist?: string;
  // 悬停卡片信息（鼠标移到按钮上显示）
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

// 每个分组里都放了一条“示例”音效，以及一个“合集”堆叠按钮示例：
//   普通音效：zh=按钮文字、path=音频路径、info=悬停卡片（time/title/note/thumb 均可留空）。
//   堆叠按钮：title=合集名、voices=多个音频；同样用 zh/path/info 描述每条音频。
// 复制即可增加，删掉即可移除。
export const voiceGroups: VoiceGroup[] = [
  {
    groupName: 'cry_lyrics',
    title: '悲鸣',
    voices: [
      {
        path: 'cry_lyrics/示例.mp3',
        zh: '示例：悲鸣按钮（改成音效名）',
        info: {
          time: '2024年3月15日 21:30',
          title: '半夜唱歌',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
    stacks: [
      {
        title: '悲鸣合集',
        voices: [
          {
            path: 'cry_lyrics/悲鸣_1.mp3',
            zh: '悲鸣 · 第一声',
            info: { time: '2024年3月15日 21:32', title: '半夜唱歌 · 片段一', thumb: '/thumbs/placeholder.svg' },
          },
          {
            path: 'cry_lyrics/悲鸣_2.mp3',
            zh: '悲鸣 · 第二声',
            info: { time: '2024年3月15日 21:35', title: '半夜唱歌 · 片段二', thumb: '/thumbs/placeholder.svg' },
          },
        ],
      },
    ],
    hiddenVoices: [
      { path: 'cry_lyrics/往日_遥远的哭声.mp3', zh: '很久很久以前的哭声…' },
    ],
  },
  {
    groupName: 'Optimism_lyrics',
    title: '励志类台词(但是从哪里切出来的你别管)',
    voices: [
      {
        path: 'Optimism_lyrics/示例.mp3',
        zh: '示例：励志按钮（改成音效名）',
        info: {
          time: '2024年3月16日 19:00',
          title: '聊聊近况',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
    stacks: [
      {
        title: '励志合集',
        voices: [
          {
            path: 'Optimism_lyrics/励志_1.mp3',
            zh: '励志 · 第一句',
            info: { time: '2024年3月16日 19:05', title: '聊聊近况 · 片段一', thumb: '/thumbs/placeholder.svg' },
          },
          {
            path: 'Optimism_lyrics/励志_2.mp3',
            zh: '励志 · 第二句',
            info: { time: '2024年3月16日 19:10', title: '聊聊近况 · 片段二', thumb: '/thumbs/placeholder.svg' },
          },
        ],
      },
    ],
    hiddenVoices: [
      { path: 'Optimism_lyrics/往日_回过头吧.mp3', zh: '没受过伤的才是小孩' },
    ],
  },
  {
    groupName: 'misc_lyrics',
    title: '抽象台/歌词',
    voices: [
      {
        path: 'misc_lyrics/示例.mp3',
        zh: '示例：抽象按钮（改成音效名）',
        info: {
          time: '2024年3月17日 22:45',
          title: '口胡大会',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
    stacks: [
      {
        title: '抽象合集',
        voices: [
          {
            path: 'misc_lyrics/抽象_1.mp3',
            zh: '抽象 · 第一段',
            info: { time: '2024年3月17日 22:50', title: '口胡大会 · 片段一', thumb: '/thumbs/placeholder.svg' },
          },
          {
            path: 'misc_lyrics/抽象_2.mp3',
            zh: '抽象 · 第二段',
            info: { time: '2024年3月17日 22:55', title: '口胡大会 · 片段二', thumb: '/thumbs/placeholder.svg' },
          },
        ],
      },
    ],
    hiddenVoices: [
      { path: 'misc_lyrics/往日_梦话.mp3', zh: '（一段很久以前的梦话）' },
    ],
  },
  {
    groupName: 'noise',
    title: '怪叫',
    voices: [
      {
        path: 'noise/示例.mp3',
        zh: '示例：怪叫按钮（改成音效名）',
        info: {
          time: '2024年3月18日 20:10',
          title: '突发恶疾',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
    stacks: [
      {
        title: '怪叫合集',
        voices: [
          {
            path: 'noise/怪叫_1.mp3',
            zh: '怪叫 · 第一声',
            info: { time: '2024年3月18日 20:12', title: '突发恶疾 · 片段一', thumb: '/thumbs/placeholder.svg' },
          },
          {
            path: 'noise/怪叫_2.mp3',
            zh: '怪叫 · 第二声',
            info: { time: '2024年3月18日 20:15', title: '突发恶疾 · 片段二', thumb: '/thumbs/placeholder.svg' },
          },
        ],
      },
    ],
    hiddenVoices: [
      { path: 'noise/往日_深夜怪响.mp3', zh: '夜深了才敢叫出口的动静' },
    ],
  },
  {
    groupName: 'cats_lyrics',
    title: '如果你变成了老大的猫猫...?',
    voices: [
      {
        path: 'cats_lyrics/示例.mp3',
        zh: '示例：猫猫按钮（改成音效名）',
        info: {
          time: '2024年3月19日 23:59',
          title: '猫猫代播',
          thumb: '/thumbs/placeholder.svg',
        },
      },
    ],
    stacks: [
      {
        title: '猫猫合集',
        voices: [
          {
            path: 'cats_lyrics/猫猫_1.mp3',
            zh: '猫猫 · 第一声',
            info: { time: '2024年3月19日 23:59', title: '猫猫代播 · 片段一', thumb: '/thumbs/placeholder.svg' },
          },
          {
            path: 'cats_lyrics/猫猫_2.mp3',
            zh: '猫猫 · 第二声',
            info: { time: '2024年3月20日 00:02', title: '猫猫代播 · 片段二', thumb: '/thumbs/placeholder.svg' },
          },
        ],
      },
    ],
    hiddenVoices: [
      { path: 'cats_lyrics/往日_轻声喵.mp3', zh: '那只名字已经被忘记的猫…' },
    ],
  },
];

// 额外彩蛋分组：仅当“往日”开关打开时出现在首页底部
export const secretGroup: VoiceGroup = {
  groupName: 'forgotten',
  title: '往日｜一些它们不愿再提起的',
  voices: [],
  hiddenVoices: [
    { path: 'forgotten/第一篇.mp3', zh: '第 1 页 · 你找到这里了' },
    { path: 'forgotten/第二篇.mp3', zh: '第 2 页 · 别告诉别人' },
    { path: 'forgotten/第三篇.mp3', zh: '第 3 页 · 雨停了的那个下午' },
  ],
};

// 随机播放下限守卫：无内容时给出提示文案
export const EMPTY_HINT = '还没有音效哦，等主人有空放进 public/audio 就能用啦';

// 彩蛋相关 localStorage 键
export const EG_UNLOCK_KEY = 'lmy-easter-unlock'; // '1' = 已被连点解锁
export const PAST_KEY = 'lmy-past'; // '1' = 打开“往日”开关
