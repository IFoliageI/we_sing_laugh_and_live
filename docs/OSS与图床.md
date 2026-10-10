# OSS 与图床

网站保持纯静态，不新增上传服务或 OSS SDK。音频、悬停缩略图、顶栏 logo、侧栏图片和社交分享图支持 HTTP(S) 读取地址。favicon 和图标字体继续作为站点自带资源。

## 逐条使用直链

在 SQLite `items.path` 填完整音频地址，在 `items.info_thumb` 填完整图片地址；首页、歌单、合集和隐藏条目使用同一规则。内容仍从数据库生成，不要手改 `src/data/content.json`。

```powershell
pnpm content:add --group noise --zh "远程音效" --path "https://bucket.example.com/audio/noise/a.mp3" --thumb "https://images.example.com/cover.webp"
pnpm build
```

完整地址优先于基础地址，查询参数、签名和已有百分号编码原样保留。音频相对路径里的 `%` 表示文件名中的实际百分号，仍按本地文件名编码。远程对象名区分大小写，同分组只拒绝完全相同的远程音频地址。

`src/data/site.ts` 中的 `logoImage`、`socialImage`、`sideLinks[].icon`、`friendLinks[].icon` 也可以填图床直链。

## 批量切换资源来源

项目根目录新增本机 `.env`，按 `.env.example` 配置，或在构建环境中设置：

```dotenv
PUBLIC_AUDIO_BASE_URL=https://bucket.example.com/audio
PUBLIC_IMAGE_BASE_URL=https://images.example.com/public
```

两个基础地址独立配置，留空继续读取本地资源。改变配置后重启开发服务，正式站点需重新构建并发布。基础地址必须是 HTTP(S) 地址，可含目录前缀，不能含查询参数、片段或账号密码。

| 内容字段 | 配置后的读取地址 |
|---|---|
| `path = songs/歌名.mp3` | `https://bucket.example.com/audio/songs/歌名.mp3` |
| `info_thumb = /thumbs/封面.png` | `https://images.example.com/public/thumbs/封面.png` |
| `logoImage = /icons/index.ico` | `https://images.example.com/public/icons/index.ico` |
| 完整 `https://…` 地址 | 直接使用原地址 |

浏览器实际请求中的中文、空格、`#` 等文件名字符会编码。配置图片基础地址时，需要同步 `thumbs/` 和使用到的 `icons/` 目录；图床只提供独立上传地址时，逐条填写直链即可，图片基础地址留空。

基础地址只改变浏览器读取位置，不上传或复制文件，也不更改数据库。`content:check` 只核对本地目录，跳过完整远程音频地址，不请求远程服务器；设置音频基础地址后，相对路径仍会按本地目录核对，因此本地缺失提示不代表 OSS 文件不存在。

## OSS 设置

使用可被浏览器读取的 HTTPS 对象地址或绑定的 CDN 域名。对象响应应提供正确的音频/图片 Content-Type；需要音频拖动或分段读取时，对象服务应支持 Range。防盗链白名单要允许正式站点域名和实际使用的开发预览来源。

本播放器通过原生 Audio 和 img 读取，不设置 `crossOrigin`，不主动携带跨域认证配置。若以后通过 fetch、Web Audio 或 canvas 读取内容，需要按使用方式配置 OSS CORS。

私有对象可以逐条填写签名 URL，但过期后需要更新内容并重新构建。静态站点不生成或刷新签名。所有 `PUBLIC_*` 值、内容 URL 及其查询参数都会出现在构建产物中，不能填写 AccessKey、Secret 或上传令牌；`.env` 已加入忽略规则。

## 桌面工具兼容范围

此改动只涉及前端仓库，数据库结构保持不变。桌面工具现有本地路径校验仍会拒绝完整音频 URL；要继续使用桌面工具编辑音频，保留相对路径并配置 `PUBLIC_AUDIO_BASE_URL`。完整音频 URL 可用前端内容命令或 SQLite 编辑器录入。桌面工具的本地音频导入不会自动上传到 OSS；克隆站点副本的构建环境需单独配置 `.env` 或环境变量。

## 验证

```powershell
pnpm test
pnpm build
pnpm content:verify
pnpm test:browser
```

浏览器检查需要安装环境已有的 Playwright 和 Chrome，并连接 Astro 开发服务。远程测试拦截示例域名的媒体请求，验证直链签名、目录映射、播放和缩略图展示，不连接真实 OSS 或上传图片。
