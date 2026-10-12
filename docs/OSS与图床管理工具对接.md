# OSS 与图床：管理工具对接与实现说明

核对日期：2026-10-12。前端实现基线：`ed684b217d9f5f3f7edbd430fbb3b7ab289e7d44`（`feat(media): 支持 OSS 音频与图床读取`）。

本文供相邻仓库 `we_sing_laugh_and_live-backend` 中的 WeSingStudio 桌面管理工具开发使用。前端行为依据已提交代码；管理工具接入点依据核对当日的本地工作区，包含尚未提交的既有修改。下文标为“建议”的配置、接口与流程尚未实现。

后续信息小卡新增可选字段 `items.info_duration`（秒数）和 `items.info_uploader`（显示名），旧库需要显式备份升级；相关录入与管理工具兼容说明见 [信息小卡元数据](信息小卡元数据.md)。这些字段独立于本文的 OSS 地址契约。

日常配置操作见 [OSS 与图床](OSS与图床.md)。本次整理只增加文档，不实现管理工具功能，也不改变数据库结构。

## 1. 当前能力与待实现范围

网站是 Astro + SolidJS 纯静态站点；管理工具是 WinUI 桌面程序，不是网站运行时 HTTP 后端。

| 能力 | 前端现状 | 管理工具现状 / 开发要求 |
|---|---|---|
| 音频 HTTP(S) 直链 | 已支持，首页、歌单、合集、隐藏条目共用 | 当前音频路径校验拒绝直链，需要调整保存和校验链 |
| 缩略图 HTTP(S) 直链 | 已支持 `items.info_thumb` | 已有图片字段；需补齐校验、预览、上传入口 |
| 音频 / 图片基础地址 | 已支持两个独立 `PUBLIC_*` 构建变量 | 当前没有对应配置字段，也没有专门传入构建进程 |
| logo、侧栏 / 友链图标、分享图 | 已支持直链和图片基础地址 | 仍配置在前端 `site.ts`，当前数据库编辑不能管理 |
| favicon、图标字体 | 保持站点本地资源 | 不在本次远程图片映射范围内 |
| 上传、列举、删除 OSS 对象 | 未实现 | 需新增桌面端服务 |
| 上传至其他图床 | 未实现 | 需按选定图床协议接入上传服务 |
| 私有对象签名生成 / 自动刷新 | 未实现；仅可读取已有签名 URL | 若增加生成能力，仍需处理静态产物中的过期地址 |
| 请求失败后自动回退本地 | 未实现 | 不应在界面承诺自动回退 |

前端不依赖具体 OSS 厂商。能够被浏览器读取的 HTTP(S) 地址即可用于播放或展示；上传协议、对象管理与认证属于管理工具扩展。

## 2. 数据与读取契约

### 2.1 保存位置

| 数据 | 当前位置 | 导出 / 生效方式 |
|---|---|---|
| 每条音频地址 | SQLite `items.path`，必填 | `scripts/lib/db.mjs` 的 `toVoice` 原值导出为 `voice.path` |
| 每条缩略图地址 | SQLite `items.info_thumb`，可空 | 原值导出为 `voice.info.thumb`；无信息时可省略 `info` |
| 音频基础地址 | `PUBLIC_AUDIO_BASE_URL` | `src/data/media.ts` 在开发启动 / 构建时读取 |
| 图片基础地址 | `PUBLIC_IMAGE_BASE_URL` | 同上 |
| 站点图片配置 | `src/data/site.ts` 中 `logoImage`、`socialImage`、`sideLinks[].icon`、`friendLinks[].icon` | `BaseLayout.astro` 调用图片地址解析 |

数据流：`data/content.db` → 内容同步脚本 → `src/data/content.json` → Astro 构建 → `dist/` → 浏览器直接请求媒体服务。

直链支持不需要数据库迁移。`settings` 表目前没有接通媒体基础地址，新增两个键不会自动生效。不要手改生成的 `content.json`，也不要把上传凭据写进内容数据库。

同分组路径有 SQLite `UNIQUE(group_id, path)` 约束。数据库约束本身不能代替应用层对本地路径的大小写归一化检查；跨分组可以引用同一对象。

### 2.2 地址优先级

1. 去掉输入首尾空白；有效的完整 HTTP(S) 地址直接使用，忽略基础地址。
2. 相对地址使用对应基础地址；基础地址为空时，音频加 `/audio/`，图片从站点根路径读取。
3. 无效地址返回空字符串；播放器提示“播放失败：音频地址无效”，损坏的悬停缩略图隐藏。

基础地址初始化校验失败会抛错，应在管理工具设置页和构建前拦截。

| 字段值 | 基础地址 | 实际请求地址 |
|---|---|---|
| 音频 `songs/a.mp3` | 空 | `/audio/songs/a.mp3` |
| 音频 `songs/a.mp3` | `https://bucket.example.com/audio` | `https://bucket.example.com/audio/songs/a.mp3` |
| 图片 `/thumbs/a.png` | 空 | `/thumbs/a.png` |
| 图片 `/thumbs/a.png` | `https://images.example.com/public` | `https://images.example.com/public/thumbs/a.png` |
| logo `/icons/index.ico` | 同上 | `https://images.example.com/public/icons/index.ico` |
| 任一完整 HTTP(S) 直链 | 任意有效基础地址 | 使用输入直链 |

基础地址必须包含实际的资源目录前缀。音频基础地址设为 `https://bucket.example.com` 时，`songs/a.mp3` 指向 `/songs/a.mp3`，不会额外添加 `/audio/`。

配置图片基础地址会同时影响相对地址的缩略图和站点图片；需要把使用到的 `thumbs/`、`icons/` 上传到匹配位置。仅返回独立链接的图床适合逐条存直链，图片基础地址可留空。

### 2.3 校验、签名与编码

以 [media-url.mjs](../src/lib/media-url.mjs) 和 [content-operations.mjs](../scripts/lib/content-operations.mjs) 为实现依据，管理工具应保持以下规则：

- 完整直链只接受 HTTP(S)，必须有主机，不能带用户名 / 密码、原始空格、ASCII 控制字符或反斜杠；`//host/path` 和 `data:`、`file:` 等地址不支持。
- 完整直链去首尾空白后原样保存、导出和播放，包括查询参数顺序、大小写、百分号编码和签名。用 `Uri` 校验后仍保存原字符串，不用 `Uri.ToString()` 或解码 / 重编码后的结果写库。
- 基础地址独立校验；允许端口与目录前缀，不允许查询参数、片段或账号密码，保存时去掉末尾 `/`。
- 本地音频仍是相对 `public/audio` 的原始文件名；保留现有盘符、绝对路径、`public/` 前缀、目录穿越及非法文件名检查。
- 相对图片路径允许已编码的文件名，每段尝试解码一次后重新编码；拒绝解码后的 `/`、反斜杠、控制字符及 `.` / `..`。不要把音频路径套用这套解码规则。
- 前端相对路径解析会把反斜杠换成 `/`、去掉前导 `/`；这不意味着管理工具或内容 CLI 允许音频根路径，写入规则仍应更严格。
- 同分组本地音频按规范化后的路径忽略大小写判重；完整远程音频按保存字符串精确判重。查询参数不同的直链可以共存，目前不做对象身份去重。

以下样例应成为 C# 与前端的一致性测试：

| 输入 | 预期 |
|---|---|
| `https://bucket.example.test/a%20b.mp3?Expires=123&Signature=A%2Fb%2Bc%3D` | 直链原样保留 |
| `https://img.example.test/a.webp?x-oss-process=image/resize,w_320&token=a%2B` | 直链和图片处理参数原样保留 |
| 音频 `songs/曲 #1%.mp3`，基础地址为空 | `/audio/songs/%E6%9B%B2%20%231%25.mp3` |
| 音频 `songs/a%20b.mp3`，基础地址为空 | `/audio/songs/a%2520b.mp3`，表示文件名中实际的 `%20` |
| 图片 `/thumbs/a%20b.png`，基础地址为空 | `/thumbs/a%20b.png` |
| 图片 `/thumbs/%2F.png`、`/thumbs/%2e%2e/a.png` | 拒绝 |
| `https://host.example/a.mp3` 与 `https://host.example/A.mp3` | 按远程规则不判为重复 |
| 本地 `songs/a.mp3` 与 `songs/A.mp3` | 同分组判为重复 |

上传完成后，写入相对音频键时应保存原始对象名；写入完整直链时应保存服务商返回的可读取链接。不要对整条 URL 执行 `encodeURIComponent`。

## 3. 管理配置与构建传递

### 3.1 建议的公开配置

建议在管理工具 `StudioConfig` 增加 `Media`。以下仅展示新增部分，不是当前已支持的配置：

```json
{
  "media": {
    "buildSource": "managed",
    "audioBaseUrl": "https://bucket.example.com/audio",
    "imageBaseUrl": "https://images.example.com/public"
  }
}
```

建议明确定义两种模式，避免新配置改变旧项目行为：

| 建议模式 | 行为 |
|---|---|
| `site`，旧配置缺省值 | 沿用站点 `.env` / 原构建环境，不由工具覆盖媒体变量 |
| `managed` | 按本次操作配置快照覆盖两个媒体变量，空字段也显式传入空字符串 |

`managed` 模式下空值表示“该资源使用本地”，不能省略环境变量，否则可能继承父进程或站点 `.env` 的旧值。模式切换也应说明重新构建后才生效。

上传设置建议另存公开配置，例如提供商类型、endpoint、bucket、音频 / 图片对象前缀、公开读取域名和凭据引用。上传 endpoint 与公开读取地址可以不同；不应从基础地址反推上传 endpoint。

实际 JSON 命名遵循现有序列化器。扩展 `StudioConfigLoader` 的默认值、规范化和往返保存，并在 `StudioConfig.Snapshot()` 深拷贝新增对象。

### 3.2 构建桥接

建议链路：选中的配置文件 → `StudioConfig.Snapshot()` → 本次构建的环境字典 → `ExternalProcessRunner.RunAsync(..., environment: ...)` → Astro → `dist/`。

`managed` 模式的公开字典只需要：

```text
PUBLIC_AUDIO_BASE_URL = snapshot.Media.AudioBaseUrl
PUBLIC_IMAGE_BASE_URL = snapshot.Media.ImageBaseUrl
```

`ProcessRunner.cs` 已支持为单个子进程设置环境变量，但 `SiteBuilder.RunPnpmAsync` 当前未传入媒体配置。`ISiteBuilder.BuildAsync` 当前只有站点根目录、日志和取消参数，需要扩展构建参数或使用按操作创建的包装器；不要把共享 builder 上可变的配置当成操作快照。

必须覆盖普通发布、发布页“仅构建”、从零克隆并上线这三个入口。克隆流程可能改变实际 `SiteRoot`，配置必须传给最终克隆目录的构建。保留 `pnpm.cmd` 定位、实时日志、取消和既有测试替身。

不建议使用进程全局 `Environment.SetEnvironmentVariable` 或自动改写站点 `.env`，以免配置切换或并行任务互相影响。上传凭据不进入这个构建字典。

媒体配置是构建输入，静态网页不读取 `studio.json`，修改服务器运行时环境也不会改变已经生成的网页。发布已有 `dist/`（例如 `buildBeforeDeploy=false`）不能保证新媒体配置已生效，界面应明确提示或通过构建记录校验。

远程数据库下载 / 恢复只恢复内容数据，不会恢复媒体配置、图床凭据或对象文件；使用相对对象键的数据库需要配套的基础地址。

## 4. 管理工具代码接入位置

下表路径均相对 `we_sing_laugh_and_live-backend` 仓库。实施前应重新核对该仓库正在进行的修改。

| 文件 / 类型 | 当前情况 | 建议修改 |
|---|---|---|
| `src/WeSingStudio.Core/Models.cs` / `ModelMapping.NormalizePath` | 无条件替换反斜杠 | 先识别并校验远程输入；有效直链原样返回，畸形直链不能通过本地归一化被“修好” |
| `src/WeSingStudio.Core/ContentValidator.cs` | 拒绝 HTTP(S)，所有路径忽略大小写判重并做本地文件检查 | 分类校验 / 判重；远程不做本地 `File.Exists`，扩展名提示读取 URL 路径部分而非查询参数 |
| `src/WeSingStudio.Core/ContentRepository.cs` | 新建和更新都调用 `NormalizePath` | 检查两条写库链的直链保真及备份 / 事务兼容性 |
| `src/WeSingStudio.App/ViewModels/ItemsPageViewModel.cs` | 保存前替换反斜杠，提前判重后调用 Core 校验 | 同步修改输入处理、提前判重和全分组二次校验；预览使用配置快照解析最终地址 |
| `src/WeSingStudio.Core/AudioFileImporter.cs` | 将音频复制到站点本地目录 | 保留本地导入，远程上传使用独立入口与服务 |
| `src/WeSingStudio.Core/StudioConfig.cs`、`StudioConfigLoader.cs` | 无媒体配置 | 新增公开设置、缺省兼容、往返保存、深拷贝快照 |
| `src/WeSingStudio.App/ViewModels/SettingsPageViewModel.cs`、`Views/SettingsPage.xaml` | 已有设置绑定 / 自动保存流程 | 接入媒体字段及凭据，保留防抖、配置切换和过期回调隔离 |
| `src/WeSingStudio.App/Views/ItemsPage.xaml` | 已有音频路径与图片字段 | 增加地址模式、预览和上传状态；图片与音频使用各自规则 |
| `src/WeSingStudio.App/Services/SiteBuilder.cs`、`ProcessRunner.cs` | 构建没有媒体参数；执行器已有子进程环境能力 | 按本次快照传两个公开构建变量 |
| `src/WeSingStudio.App/Services/PublishOrchestrator.cs`、`ViewModels/PublishPageViewModel.cs`、`Services/Deploy/FromScratchDeployService.cs` | 多个构建入口 | 接通统一构建参数，保持预演不产生副作用 |
| `src/WeSingStudio.Core/CredentialVault.cs` | 仅保存 DPAPI 加密的 SSH 密码 | 增加上传凭据，兼容旧文件，保存时保留 SSH 凭据 |
| `src/WeSingStudio.App/ViewModels/StudioServices.cs` | 已有共享操作协调 | 上传 / 构建 / 配置切换遵循既有协调；异步结果不回写已切换的条目或配置 |
| `Locales/zh-Hans/Resources.resw`、`Locales/en/Resources.resw` | 两套界面文案 | 同步增加字段、错误、状态与提示 |

仅删除 `ContentValidator` 中的 HTTP(S) 拒绝逻辑不足以完成支持：ViewModel、Core 判重与 Repository 归一化必须一致。

站点 logo / 友链管理需另行确定 `site.ts` 的可编辑配置与生成链路；仅把相关值写进数据库 `settings` 不会让页面变化。

## 5. 上传与对象管理建议

### 5.1 服务边界与返回值

建议先选定一个 OSS 提供商和实际使用的图床，分别实现上传适配器。共同返回结构可包含：`provider`、`objectKey`（可空）、`publicUrl`、`contentType`、`size`、`etag`（可空）、操作 / 配置标识。上传凭据只在桌面服务内部读取。

只有具有稳定对象目录映射的 OSS 才适合把上传结果保存成相对键。以音频基础地址 `/audio`、对象键 `audio/songs/a.mp3` 为例，数据库保存 `songs/a.mp3`；图片基础地址 `/public`、对象键 `public/thumbs/a.png`，数据库保存 `/thumbs/a.png`。去前缀必须检查目录边界和大小写，不能全局字符串替换。

上传的目录前缀与构建基础地址必须一致。无法确定映射关系，或图床只返回独立公开链接时，保存完整 `publicUrl`。删除对象使用上传记录中的提供商 / bucket / 对象键，不能根据任意外部 URL 猜测。

### 5.2 最小流程

1. 用户选择文件与目标配置，捕获配置、目标条目和本次操作标识；检查文件大小 / 类型。
2. 生成唯一对象键，上传时避免静默覆盖已有对象；显示进度并支持取消。
3. 成功后校验读取链接，将相对键或完整直链写入当前编辑草稿，允许试听 / 图片预览。
4. 用户执行现有“保存”动作时，经过统一校验、备份和事务写入 `items.path` / `items.info_thumb`。
5. 再执行内容同步、构建和发布；展示各阶段独立状态。

不要在上传成功前修改数据库，上传完成也不自动发布。重试应复用本次操作标识并处理结果不明的上传，避免重复上传或误覆盖。配置 / 条目切换后，旧操作结果不能覆盖新草稿。

上传成功但保存失败、取消编辑或构建失败会留下未引用对象。数据库备份与网页版本回滚不会撤销 OSS 上传，删除也无法通过数据库回滚恢复。

建议保留本地上传台账用于查找未引用对象；凭据和签名参数不写普通日志。若签名 URL 作为内容保存，它及参数会进入数据库和静态内容产物，这是读取方案的固有可见性。

对象删除应作为独立管理操作：检查本工具可见的音频 / 图片引用，告知跨站点引用无法完全检测，并经过明确确认。删除内容条目默认只删记录，不连带删除共享对象、任意图床链接或未登记资产。

### 5.3 凭据与读取条件

`CredentialVault` 当前使用 Windows DPAPI `CurrentUser` 和同目录临时文件原子替换。扩展时应保持旧 SSH 密码读取、空凭据处理和配置对应的凭据文件行为；多套配置 / 多个提供商应使用明确的凭据标识。

AccessKey、Secret、图床令牌不进入 `PUBLIC_*`、`site.ts`、`content.json`、普通日志或 Git。上传权限与公开读取地址分开配置。

浏览器使用原生 `Audio` / `img`，当前未设置 `crossOrigin` 或自定义认证头。建议使用 HTTPS 可读取对象，正确的 Content-Type，并检查音频 Range 与防盗链来源。未来引入 fetch、Web Audio 或 canvas 时，再按读取方式配置 CORS。

已有签名 URL 可以播放，但静态站点不会续签。若工具生成签名链接，应提示有效期并规划更新内容、重新构建与发布。前端彩蛋隐藏不构成访问控制。

## 6. 开发顺序与验收

建议分三阶段交付：

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| P0：读取与配置 | 远程音频保存、图片校验 / 预览、媒体配置与所有构建入口 | 从管理工具录入直链或设置基础地址后，构建站点正确读取 |
| P1：上传 | OSS / 图床适配器、文件选择、进度 / 取消、上传台账、草稿回填 | 上传与保存分阶段，失败不损坏数据，也不覆盖已有对象 |
| P2：资产管理 | 列表 / 搜索、引用检查、清理、更多提供商 | 能识别管理范围，共享资源不会随条目删除而被误删 |

建议覆盖以下验收项：

| 场景 | 预期 / 测试位置 |
|---|---|
| 签名直链新建、编辑、同步、构建 | 字符串不重编码、不改参数；Core Repository / Validator 与前端媒体测试 |
| 远程音频带查询参数、没有扩展名 | 不做本地文件检查；扩展名仅可作为非阻断提醒 |
| 同分组大小写不同的路径 | 远程允许、本地拒绝；ViewModel 与 Core 行为一致 |
| 空图片、非法协议、穿越 / 已编码分隔符 | 空图片允许，其余按地址契约拒绝；本地导入规则不放宽 |
| 中文、空格、`#`、`%` 文件名 | 对照第 2.3 节，不混淆音频与图片编码规则 |
| 基础地址无效 | 设置反馈 / 构建前校验；不发布半成品 |
| 切换配置 A → B，操作期间修改设置 | 使用操作快照；不串基础地址、凭据或草稿结果 |
| `managed` 模式留空 / `site` 模式 | 显式空值恢复本地；站点模式保留旧配置行为 |
| 仅构建、普通发布、克隆上线 | 三个入口使用相同媒体契约；实际 clone 目录正确 |
| 预演及跳过构建 | 预演不上传 / 改文件 / 调构建；旧 `dist/` 不误称采用新配置 |
| 上传失败、取消、成功后保存失败 | 原数据库不受上传失败影响；未引用对象可追踪，旧回调不改新条目 |
| 删除条目、共享对象、版本回滚 | 不自动删除对象；网页 / 数据库回滚边界明确 |
| 凭据迁移与保存失败 | 旧 SSH 密码保留；密文文件失败时不损坏旧文件 |
| 真实媒体服务 | 正式 / 预览来源播放、拖动、图片加载与错误状态；另做实际服务验收 |

前端相关代码与测试：

- [媒体地址解析](../src/lib/media-url.mjs)、[运行时封装](../src/lib/media.ts)、[构建变量读取](../src/data/media.ts)。
- [内容写入规则](../scripts/lib/content-operations.mjs)、[SQLite 导出](../scripts/lib/db.mjs)、[数据库结构](../data/schema.sql)。
- [媒体单元测试](../tests/media.test.mjs)、[内容测试](../tests/content.test.mjs)、[浏览器检查](../tests/browser.mjs)。

前端复验命令为 `pnpm test`、`pnpm build`、`pnpm content:verify`、`pnpm test:browser`；浏览器检查需已有 Playwright / Chrome 及运行中的站点服务，连接配置见测试脚本。管理工具可扩展 `tests/WeSingStudio.Core.Tests` 的 Validator / Repository / 导入测试及 `tests/e2e/WeSingStudio.E2E` 的配置切换、往返保存和发布可靠性检查。

现有前端浏览器远程用例拦截示例域名请求，不能替代真实 OSS / 图床验收。`content:check` 跳过完整远程音频地址；相对音频仍检查本地目录，即使已设置 OSS 基础地址，也不能凭本地缺失提示判断对象不存在。

## 7. 可直接用于开发交接的任务说明

> 在 WeSingStudio 当前工作区实现本文 P0、P1。先核对既有未提交修改，保留本地导入、数据库备份 / 事务、配置隔离和发布预演行为。复用现有 `items.path` / `items.info_thumb`，远程地址校验后原样保存；媒体配置通过操作快照传入构建子进程。上传只回填草稿，保存和发布沿用现有独立动作。具体 OSS / 图床提供商、上传 endpoint、bucket、目录前缀、公开域名和认证方式需按实际账户确定；先完成不依赖账户的 P0，不把示例地址当真实配置。按第 6 节验收并说明真实服务测试结果。
