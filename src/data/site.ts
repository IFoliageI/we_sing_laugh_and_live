export const site = {
  // 站点名称（顶栏 / 标题）
  title: '渺の怪动静播放器',
  // SEO 描述
  description: '是个会发出怪动静的按钮网站咕',
  keywords: 'VTuber, VoiceButton, 临小渺',
  // 社交分享封面图（预留，可换）
  socialImage: '',
  themeColor: '#E9DACD',

  footer: {
    content: '本站全都是渺渺の怪动静哦~',
  },
};

// 侧边栏品牌 / 推广链接（图标与站点 favicon 分开，使用独立的外链图标）
export interface Links {
  title: string;
  url: string;
  icon: string; // 图标：图片地址（侧边栏外链专用，如 /icons/external-link.svg）
}

export const sideLinks: Links[] = [
  { title: '老大的主页', url: 'https://space.bilibili.com/3707066919160157', icon: '/icons/external-link.ico' },
  { title: '老大的直播间', url: 'https://live.bilibili.com/1890515615', icon: '/icons/external-link.ico' },
];

// 侧边栏「友链」——格式和上面 sideLinks 完全一样：
//   加一行 = 多一个友链；删一行 = 少一个友链；全删光（保持 []）= 侧边栏自动隐藏「友链」这一栏。
// 下面留了一行注释好的例子，去掉行首的 // 并改成你自己的即可生效。
export const friendLinks: Links[] = [
  { title: '友站', url: 'https://example.com', icon: '/icons/external-link.ico' },
];