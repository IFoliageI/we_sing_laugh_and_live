# 三平台部署指南 · Cloudflare Pages / Cloudflare Workers / GitHub Pages

> 适用对象：`渺の怪动静 / 渺の歌单`（Astro 5 + SolidJS，`output: 'static'`，产物 `dist/`）。
> 更新日期：2026-10-24。
> 本文**只讲静态托管**：站点没有运行时数据库，内容源是仓库里的 `data/content.db`（构建期读取），
> 构建产物是纯 HTML/CSS/JS。这与 `部署/部署指南.md`（nginx 手动部署）是并列关系，不替代它。
>
> **本次状态（2026-10-24）**：新增 `wrangler.jsonc`、`.github/workflows/deploy.yml`、`.node-version`、
> `public/_headers`、`public/_redirects` 与本文件。子路径支持（`SITE_BASE` / `SITE_URL` → Astro 的 `base` / `site`）
> 已由主线落地到 `astro.config.mjs`、`src/lib/asset-url.ts` 与 4 处调用点，但**本会话没能跑通一次子路径构建做实测**
> （沙盒内 `astro build` 被拒绝，见第 9 节）；首次真机部署请按 5.3 节的验收步骤自查一遍。

---

## 目录

0. [先看这里：三条路线怎么选](#0-先看这里三条路线怎么选)
1. [三种方式对比](#1-三种方式对比)
2. [Cloudflare Pages](#2-cloudflare-pages)
3. [Cloudflare Workers（静态资源模式）](#3-cloudflare-workers静态资源模式)
4. [GitHub Pages](#4-github-pages)
5. [子路径部署原理：BASE_URL 与 4 处硬编码](#5-子路径部署原理base_url-与-4-处硬编码)
6. [常见故障排查](#6-常见故障排查)
7. [与现有 nginx 部署的关系](#7-与现有-nginx-部署的关系)
8. [官方文档链接汇总](#8-官方文档链接汇总)
9. [本次未能实测的事项](#9-本次未能实测的事项)

---

## 0. 先看这里：三条路线怎么选

| 你的诉求 | 选哪个 | 原因 |
|---|---|---|
| 最快上线、几乎不花钱、带 PR 预览 | **Cloudflare Pages**（第 2 节） | 连上 GitHub 就自动构建；免费额度足够这种小站；`pages.dev` 域名开箱可用 |
| 要在**同一个域名的子路径**下挂站点（`example.com/yuki/`），或用 Workers 的 Preview/日志 | **Cloudflare Workers**（第 3 节） | Workers 支持把静态资源挂在路径前缀下，Pages 不支持 |
| 完全不想用 Cloudflare、只用 GitHub | **GitHub Pages**（第 4 节） | 零成本；项目页天生在 `/<仓库名>/` 子路径，靠 `SITE_BASE` 适配（主线已落地，见第 5 节） |

> ★ **一句话结论**：三条路线都可以走，但验证程度不同。
> - **Cloudflare Pages**（根路径）：今天就能上，不需要任何代码改动，只需面板配置；
> - **GitHub Pages**（`/<仓库名>/` 子路径）：子路径机制已由主线落地（`astro.config.mjs` + `src/lib/asset-url.ts`），
>   但**还差一次真实构建验证**——本会话沙盒里跑不了 `astro build`（见第 9 节）；
> - **Cloudflare Workers**：需要另建一份 `wrangler.worker.jsonc`（第 3 节给了模板，仓库里没有该文件）。

---

## 1. 三种方式对比

| 维度 | Cloudflare Pages | Cloudflare Workers（静态资源） | GitHub Pages |
|---|---|---|---|
| 配置文件 | `wrangler.jsonc`（`pages_build_output_dir`） | `wrangler.jsonc`（`assets.directory`），**与 Pages 不能共用同一份** | 无配置约定，靠 `.github/workflows/deploy.yml` |
| 部署命令 | GitHub 集成自动构建，或 `wrangler pages deploy` | `wrangler deploy` | `actions/deploy-pages` |
| 站点根路径 | 域名根（`pages.dev` 或自定义域） | 域名根 **或路径前缀**（支持子目录） | 用户主页在根，**项目页在 `/<仓库名>/`** |
| `_headers` / `_redirects` | ✅ 支持（本文已提供） | ✅ 同样支持（同一套文件） | ❌ 不解析，只会被当成普通文件发布 |
| 自定义域名 | ✅ 支持 CNAME 到非 Cloudflare 托管的域名 | ⚠️ 只支持 DNS 托管在 Cloudflare 的域名 | ✅ 支持（CNAME 到 `<owner>.github.io`） |
| 每次部署的产物缓存 | 部署后全量替换，旧文件不再服务 | 同 Pages | 同 Pages（Actions 方式） |
| Range 请求（拖进度条） | 目前返回 200 而非 206，Cloudflare 在处理 | 同 Pages | GitHub 的边缘缓存通常支持 206，但无保证 |
| 构建期能否拿到 D1 binding | ❌（binding 只对 Functions 运行时可见） | ❌（同理，只对 Worker 运行时可见） | ❌ 无 Cloudflare 资源 |
| 需要凭据吗 | 直接用面板/GitHub 集成不需要；CLI 部署需要 API Token | 需要 API Token | 不需要，用内置 `GITHUB_TOKEN` + OIDC |
| 成本 | 免费额度足够 | 静态资源请求免费，Functions 另计 | 免费（公开仓库；私有仓库需付费计划） |

> 平台差异来源：Cloudflare 官方 Pages↔Workers 兼容性对照表
> <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/#compatibility-matrix>

---

## 2. Cloudflare Pages

### 2.1 仓库里已就绪的东西

| 文件 | 作用 |
|---|---|
| `wrangler.jsonc` | Pages 项目配置：`name` / `compatibility_date` / `pages_build_output_dir: "./dist"`。D1 binding 故意不启用（原因写在文件注释里） |
| `public/_headers` | 响应头：HTML 不强缓存、`/_astro/*` 不可变长缓存、`*.ttf` 显式 `font/ttf`、素材 30 天、音频 7 天、基础安全头 |
| `public/_redirects` | 只做尾斜杠与 `index.html` 规范化 301；**没有** `/* /index.html 200` 这种吞 404 的通配 |
| `.node-version` | `24.19.0`，与团队本机环境一致 |
| `.github/workflows/deploy.yml` | GitHub Pages 流水线（与 Pages 无关，见第 4 节） |

> `public/` 里的文件会被 Astro 原样复制到 `dist/`，所以部署后是 `dist/_headers` 与 `dist/_redirects`。
> `.node-version` 不同：它在**仓库根目录**，由 Node 版本管理器 / CI / Cloudflare 构建镜像读取，不进 `dist/`。

### 2.2 路径 A：GitHub 集成（推荐，零凭据）

1. Cloudflare 面板 → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，授权 GitHub，选中本仓库。
2. 构建设置按下表填（**Framework preset 选 Astro 也可以，但命令必须按本仓库实际情况改**）：

| 字段 | 值 | 说明 |
|---|---|---|
| Production branch | `main` | 其他分支自动成为预览部署 |
| Framework preset | `Astro`（或 `None`） | 只是预填命令，不影响实际行为 |
| Build command | `pnpm build` | 内部先 `node scripts/content-sync.mjs` 再从 SQLite 生成 `src/data/content.json`，最后 `astro build` |
| Build output directory | `dist` | 与 `wrangler.jsonc` 的 `pages_build_output_dir` 一致 |
| Root directory | 留空（仓库根） | 不是 monorepo |

3. **环境变量**（Settings → Environment variables，Production 与 Preview 都加）：

| 变量 | 值 | 为什么必须有 |
|---|---|---|
| `NODE_VERSION` | `24.19.0` | v3 构建镜像默认 Node 是 22.x；用 `.node-version` 也能生效，写变量是双保险 |
| `PNPM_VERSION` | `11.21.0` | ★ v3 构建镜像默认 pnpm 是 10.x，而且**不会**从 `pnpm-lock.yaml` 推断版本（官方限制里写明了） |
| `SITE_BASE` | `/`（或干脆不设） | `astro.config.mjs` 已支持；Pages 走域名根，不设即等价于 `/`，见第 5 节 |
| `SITE_URL` | `https://<项目名>.pages.dev` | `astro.config.mjs` 已支持，写入 Astro 的 `site`，用于生成绝对 URL / SEO |
| `CONTENT_SOURCE` | 不设置（= local） | 只有切换到 D1 REST 取数时才设 `d1` |

4. 保存并首次部署。Pages 会**自动先安装依赖**再执行构建命令（`SKIP_DEPENDENCY_INSTALL=1` 可关闭），所以构建命令里不要再写 `pnpm install`。

> ⚠️ **一旦提交 `wrangler.jsonc`，它就是 Pages 项目配置的唯一来源**：面板里对应字段会变成只读。
> 如果项目已经在面板里建好且名字不同，先改名或改 `wrangler.jsonc` 的 `name`（只能用小写字母、数字、连字符）。
> 官方说明：<https://developers.cloudflare.com/pages/functions/wrangler-configuration/>

### 2.3 路径 B：本地/CI 直接上传（`wrangler pages deploy`）

适合不想让 Cloudflare 拉仓库、或者在 GitHub Actions 里做「先测后传」的场景。
仓库**没有**把 `wrangler` 加进依赖（不改 `package.json`），用 `npx` 临时调起：

```bash
# 1) 本地构建（内容源仍是本地 SQLite）
pnpm build

# 2) 登录一次（会写进用户目录的配置文件，不会进仓库）
npx wrangler@4 login

# 3) 上传 dist/
npx wrangler@4 pages deploy dist --project-name we-sing-laugh-and-live --branch main
```

CI 里改成环境变量（**只用占位符，真实值放 CI Secret**）：

```bash
export CLOUDFLARE_API_TOKEN="${{ secrets.CLOUDFLARE_API_TOKEN }}"   # 示例占位，真实值不落仓库
export CLOUDFLARE_ACCOUNT_ID="${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
pnpm build
npx wrangler@4 pages deploy dist --project-name we-sing-laugh-and-live --branch main
```

说明：
- `wrangler` 版本要求：用 Wrangler 配置文件管理 Pages 需要 **≥ 3.45.0**；JSONC 配置从 **3.91.0** 起支持（本仓库用 `wrangler.jsonc`）。直接用 `wrangler@4` 即可。
- `--branch main` 决定这次算「生产部署」还是「预览部署」，漏了会按当前 git 分支推断。
- 官方文档：<https://developers.cloudflare.com/pages/get-started/direct-upload/>

### 2.4 部署后自查

```bash
BASE=https://we-sing-laugh-and-live.pages.dev
curl -sI "$BASE/"                             | head -5   # 200 + Cache-Control: no-cache
curl -sI "$BASE/_astro/$(ls dist/_astro | head -1)" | grep -i cache-control   # immutable
curl -sI "$BASE/fonts/SegoeFluentIcons.ttf"   | grep -i content-type         # 期望 font/ttf
curl -s  "$BASE/"                             | grep -o '<title>[^<]*</title>'
```

期望结果：首页、`/request/`、`/about/` 都是 200；字体是 `font/ttf`；
`/_astro/*` 带 `max-age=31536000, immutable`；HTML 带 `no-cache`。

---

## 3. Cloudflare Workers（静态资源模式）

### 3.1 为什么不能直接复用 `wrangler.jsonc`

Pages 用 `pages_build_output_dir`，Workers 用 `assets.directory`，两者是不同的配置方言：

- 官方迁移文档明确要求把 `pages_build_output_dir` **替换**成 `assets.directory`；
- 一个 Wrangler 配置文件不能同时表达「Pages 项目」和「Worker」两种身份。

所以 Workers 路线要**另建一份配置**，用 `-c` 指定（本仓库为了不给 Pages 部署添乱，没有把这份文件写进仓库）：

### 3.2 `wrangler.worker.jsonc`（需要时自行创建）

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "we-sing-laugh-and-live-worker",
  "compatibility_date": "2026-10-24",
  "assets": {
    "directory": "./dist",
    // 本站是多页静态站：找不到就返回最近的 404.html（没有 404.html 时返回无内容的 404）
    "not_found_handling": "404-page",
    // 目录型页面带尾斜杠（/about/），单文件页面不带（/foo.html）
    "html_handling": "auto-trailing-slash"
  }
  // 只有静态资源、没有 Worker 脚本时：不要写 "binding": "ASSETS"（它要求存在 main）
}
```

- `_headers` / `_redirects` 在 Workers 静态资源里**同样生效**，所以第 2 节的 `public/` 那两份文件不用改。
- 想让 Worker 脚本先跑（鉴权、日志），再加 `main` + `assets.run_worker_first`。
- 官方文档：
  - 静态资源总览 <https://developers.cloudflare.com/workers/static-assets/>
  - SSG 路由与自定义 404 <https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/>

### 3.3 部署

```bash
pnpm build
npx wrangler@4 deploy -c wrangler.worker.jsonc
```

CI 里同样用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`（占位符，真实值放 Secret）。
Worker 默认给 `<name>.<子域>.workers.dev`；自定义域名要求该域名的 DNS 托管在 Cloudflare（Pages 支持 CNAME 到外部域名，这是两者的关键差别）。

### 3.4 什么时候值得上 Workers

| 场景 | Pages | Workers |
|---|---|---|
| 只想托管静态站 | ✅ 更省事 | 也行，但配置更啰嗦 |
| 要在 `example.com/yuki/` 这种**子路径**下发布 | ❌ 不支持 | ✅ 支持（`assets` + 路由） |
| 需要请求日志 / Tail / 灰度发布 | 部分 | ✅ |
| 域名 DNS 不在 Cloudflare | ✅ 支持 CNAME | ❌ 不支持 |

---

## 4. GitHub Pages

### 4.1 仓库设置（一次性）

1. Settings → **Pages** → Build and deployment → **Source 选「GitHub Actions」**（不要选「Deploy from a branch」）。
2. push 到 `main` 即触发 `.github/workflows/deploy.yml`；也可以在 Actions 页手动 `Run workflow`。
3. 部署完成后地址是 `https://<owner>.github.io/<仓库名>/`（本项目即 `.../we_sing_laugh_and_live/`）。

流水线做过的事：

```
checkout@v7 → pnpm/action-setup@v6 (pnpm 11.21.0) → setup-node@v7 (读 .node-version)
→ pnpm install --frozen-lockfile → pnpm test → pnpm build
→ upload-pages-artifact@v5 → deploy-pages@v5
```

权限块按官方模板写死为最小集：

```yaml
permissions:
  contents: read   # 读仓库
  pages: write     # 发布 Pages
  id-token: write  # deploy-pages 用 OIDC 换令牌，缺了必失败
concurrency:
  group: pages
  cancel-in-progress: false   # 不打断进行中的部署
```

> 版本核对日期 2026-10-24：`checkout@v7`、`setup-node@v7`、`pnpm/action-setup@v6`、
> `upload-pages-artifact@v5`、`deploy-pages@v5` 均为当前最新大版本。
> GitHub 官方文档里的示例仍写 `@v4`/`@v6`（文档更新滞后），以各 action 仓库的 Release 为准。

### 4.2 项目页子路径 与 `.nojekyll`

**子路径（`SITE_BASE`，主线已落地）**

GitHub 项目页不是挂在域名根，而是挂在 `/<仓库名>/` 下。构建时必须告诉 Astro 这件事，否则
`_astro/*.css`、`/favicon.ico` 之类的绝对路径会指向 `https://<owner>.github.io/_astro/...` → 全 404。

本仓库约定的两个环境变量（`astro.config.mjs` 已读取，原理见第 5 节）：

| 变量 | 本次 workflow 的值 | 传进 Astro 之后 |
|---|---|---|
| `SITE_BASE` | `/${{ github.event.repository.name }}/` → `/we_sing_laugh_and_live/` | 变成 `base`；`import.meta.env.BASE_URL` 取同值 |
| `SITE_URL` | `https://<owner>.github.io/<仓库名>/` | 变成 `site`（用于绝对 URL / SEO） |

换成自定义域名或用户主页时，把 `SITE_BASE` 改成 `/`（或删掉这一行），`SITE_URL` 改成正式域名。

**`.nojekyll` 注意事项**

| 发布方式 | 需要 `.nojekyll` 吗 | 原因 |
|---|---|---|
| **Actions artifact**（本仓库用的） | ❌ 不需要 | 这条链路不经过 Jekyll，`_astro/` 这类下划线目录不会被吞 |
| 从分支发布（把 `dist` 推到一个分支） | ✅ **必须** | Jekyll 默认忽略 `_` 开头的文件/目录 → `_astro/` 会被丢掉，站点样式全没 |

若以后改成「把产物推到分支」：在产物根目录放一个空的 `.nojekyll` 再提交。
另外注意 `upload-pages-artifact@v5` 默认**不上传隐藏文件**（以 `.` 开头的会被忽略），
v5 新增了 `include-hidden-files: true` 才能把它们带进 artifact —— 也就是说这两条路都不要指望
`dist/.nojekyll` 被自动带过去。

> 顺带一提：`public/_headers`、`public/_redirects` 会被 Astro 复制进 `dist/`，GitHub Pages
> 不解析它们，只是当成普通文件发布（文件名以下划线开头，不需要 `.nojekyll` 也能访问），**不生效但无害**。

### 4.3 自定义域名

1. 仓库 Settings → Pages → Custom domain 填入域名（会生成 `CNAME` 记录要求：`<你的域名> CNAME <owner>.github.io`）。
2. DNS 侧配 CNAME 后等待证书签发（HTTPS 强制勾选推荐）。
3. **必须同时**把 `SITE_BASE` 改成 `/`、`SITE_URL` 改成 `https://你的域名/` 再重新构建 —— 否则页面里的资源仍带旧子路径。
4. 仓库根目录放 `CNAME` 文件不会自动改设置（官方说明）；用 Settings 或 API 配置。
   官方文档：<https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site>

### 4.4 限制与坑

- 站点体积 **≤ 1 GB**、软性带宽 **100 GB/月**、每小时构建次数有限 —— 本站 `public/` 只有 0.4 MB，完全够用。
  官方限制：<https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- 没有 `404.html` 时，未匹配路径会显示 GitHub 的默认 404 页（**不会**返回首页，这点比 Cloudflare Pages 好）；
  想自定义就加 `src/pages/404.astro`。
- 仓库必须是公开的（免费计划），私有仓库发布 Pages 需要付费计划。
- 没有任何响应头自定义能力：字体 MIME、缓存策略全部由 GitHub 决定，`_headers` 在这里是摆设。

---

## 5. 子路径部署原理：`BASE_URL` 与 4 处硬编码

### 5.1 Astro 的 `base` 与 `import.meta.env.BASE_URL`

- `astro.config.mjs` 里设置 `base: '/<仓库名>/'` 后，Astro 生成的资源 URL 都会带前缀，
  并且 `import.meta.env.BASE_URL` 在构建期等于 `/<仓库名>/`（不设 `base` 时等于 `/`）。
- 源码里所有「指向自己站内文件」的绝对路径都必须改成 `import.meta.env.BASE_URL` 拼出来的值，
  否则子路径部署下它们仍会指向域名根。
- 参考：<https://docs.astro.build/en/reference/configuration-reference/#base>、
  <https://docs.astro.build/en/guides/environment-variables/>

### 5.2 4 处硬编码的位置与现在的处理（主线已落地）

交接材料列出的 4 处「写死域名根」的地方，现在都改成按部署基路径拼接。
公共逻辑抽在新增的 `src/lib/asset-url.ts` 里，前缀来自 `import.meta.env.BASE_URL`：

| # | 原位置 | 现在的处理 |
|---|---|---|
| 1 | `src/lib/media.ts:5` `resolveMediaUrl(path, baseUrl, '/audio')` | 前缀改成 `${basePrefix}/audio`；`imageUrl()`（顶栏 logo、侧栏图标、缩略图）的前缀改成 `basePrefix` |
| 2 | `src/data/site.ts:5,26,27,34` 的 `'/icons/...'` | **数据本身保持原样**（仍写 `'/icons/...'`），由渲染层的 `imageUrl()` 统一补前缀 —— 这里不要再套一次 `assetUrl()`，否则前缀会重复 |
| 3 | `src/layouts/BaseLayout.astro` 的 `href="/favicon.ico"`、`href="/"`、`href="/request/"`、`href="/about/"` | 全部改成 `assetUrl(...)`；favicon 用 `assetUrl('/favicon.ico')` |
| 4 | `src/styles/global.css` 的 `@font-face { src: url('/fonts/...') }` | 从 CSS 移出，改在 `BaseLayout.astro` 里用 `<style is:global set:html>` 注入 `url('${assetUrl('/fonts/SegoeFluentIcons.ttf')}')` —— CSS 文件里拿不到 `import.meta.env`，这是绕开的办法 |

`astro.config.mjs` 的读入方式（**两个变量都不设时不产生** `site` / `base` 键，构建结果与改造前一致）：

```js
const site = process.env.SITE_URL?.trim() || '';
const rawBase = process.env.SITE_BASE?.trim() || '';
const normalizedBase = rawBase.replace(/^\/+|\/+$/g, '');
const base = normalizedBase ? `/${normalizedBase}/` : '';
// defineConfig({ ...(site ? { site } : {}), ...(base ? { base } : {}) })
```

> `SITE_BASE` 会被规范成「以 `/` 开头、以 `/` 结尾」：写 `we_sing_laugh_and_live`、
> `/we_sing_laugh_and_live`、`/we_sing_laugh_and_live/` 效果相同；写 `/` 等价于不设。

### 5.3 验收步骤（请在有权限的环境跑一遍）

> ⚠️ 本会话的沙盒里 `astro build` 跑不起来（Vite 在 Windows 需要 spawn 子进程，被沙盒以 EPERM 拒绝），
> 所以下面四条**没有实测**，请第一次部署时逐条自查。

1. **默认路径回归**（不设任何变量）：
   ```bash
   pnpm build
   ```
   期望：`src/data/content.json` 的 SHA256 仍是
   `3BD9991FB37D405A4DD6A0990A442298F7683BB5ECD5981C742CF620CFD4B10D`；
   `dist/index.html` 里的资源仍是 `/_astro/...`（不带前缀）。
2. **子路径构建**：
   ```bash
   SITE_BASE=/we_sing_laugh_and_live/ SITE_URL=https://<owner>.github.io/we_sing_laugh_and_live/ pnpm build
   ```
   期望：`dist/index.html` 里的 CSS/JS 变成 `/we_sing_laugh_and_live/_astro/...`，
   favicon 变成 `/we_sing_laugh_and_live/favicon.ico`，内联 `@font-face` 的 `url()` 也带前缀。
3. **本地 HTTP 验收**：把 `dist/` 放到 `/we_sing_laugh_and_live/` 前缀下起静态服务器，逐个访问
   首页 / `request/` / `about/`，以及 favicon、`icons/*`、`audio/*`、`fonts/SegoeFluentIcons.ttf`，全部应为 200。
4. **真机验收**：GitHub Actions 跑完后打开 `https://<owner>.github.io/<仓库名>/`，
   F12 的 Console 不应有 404，侧边栏三个导航项都停留在子路径内。

> 仍然常见、但**不是配置错**的失败：
> - 只改了 `SITE_BASE` 却没重新构建（环境变量只在构建期读取）；
> - 用 `pnpm dev` 看子路径（`base` 也影响 dev server，要访问 `http://localhost:4321/<base>/`）；
> - 部署到 Cloudflare Pages 却传了子路径的 `SITE_BASE`（Pages 走域名根，应留空或 `/`）。

### 5.4 三平台对「子路径」的支持程度

| 平台 | 能否挂在 `example.com/yuki/` | 说明 |
|---|---|---|
| GitHub Pages 项目页 | ✅（天生如此） | 路径前缀固定为 `/<仓库名>/`，必须靠 `base` 适配 |
| Cloudflare Pages | ❌ | 一个 Pages 项目对应一个主机名根；官方兼容性表里「Serve assets on a path」Pages 标 ❌ |
| Cloudflare Workers | ✅ | 支持把 `assets` 挂在路径前缀下；`_redirects` 里的来源路径也要跟着加前缀 |

---

## 6. 常见故障排查

### 6.1 404 类

| 症状 | 最可能原因 | 怎么查 / 怎么修 |
|---|---|---|
| GitHub Pages 首页能开，但样式全丢、控制台一片 404 | `SITE_BASE` 没传进构建（漏了环境变量，或改了没重新构建） | F12 → Network，看 `_astro/*.css` 是否请求到了域名根；确认构建步里 `SITE_BASE=/<仓库名>/` 生效，产物 HTML 的路径带前缀 |
| GitHub Pages 直接 404 整个站 | Pages Source 没选「GitHub Actions」，或 workflow 失败 | Actions 页看 `deploy` 作业；Settings → Pages 确认 Source |
| Cloudflare Pages 访问不存在的地址却返回首页 200 | `dist/` 里**没有** `404.html`，Pages 自动走 SPA 兜底 | 加 `src/pages/404.astro` 让 Astro 产出 `dist/404.html`；或改用 Workers 的 `not_found_handling: "404-page"` |
| `/about` 与 `/about/` 两个地址都能开 | 尾斜杠行为不统一 | 已由 `public/_redirects` 的 301 钉住；Cloudflare 侧才生效 |
| 音频 404，但本地 Windows 能放 | 服务器/CI 是大小写敏感文件系统 | 核对 `voices.ts` 里的 `path` 与 `public/audio/` 实际文件名**逐字符大小写一致** |
| `_headers`/`_redirects` 完全不生效 | 部署到了 GitHub Pages，或文件没进 `dist/` | 本地 `pnpm build` 后确认 `dist/_headers`、`dist/_redirects` 存在；只有 Cloudflare 会解析 |

### 6.2 字体 MIME 类

| 症状 | 原因 | 修法 |
|---|---|---|
| 图标全是方块 / 空白，F12 报字体 MIME 不对 | `.ttf` 被当成 `application/octet-stream` | 确认 `public/_headers` 里 `/*.ttf` 的 `Content-Type: font/ttf` 规则生效：`curl -sI https://.../fonts/SegoeFluentIcons.ttf \| grep -i content-type` |
| 改了 `_headers` 没反应 | 规则块缩进不对 / 路径模式写错 / 单次部署已缓存 | 路径行顶格、响应头缩进；Cloudflare 只在**新部署**生效，重新部署一次 |
| 换了 GitHub Pages 后图标坏掉 | GitHub 不读 `_headers`，字体 MIME 由平台决定 | 先按第 5 节确认 `base` / `SITE_BASE` 已生效；GitHub 侧无法自定义 MIME，若真被当成 `octet-stream`，只能改成由 Astro 资源管线输出字体（import 后落到 `_astro/`） |

### 6.3 缓存类

| 症状 | 原因 | 修法 |
|---|---|---|
| 内容更新了，页面还是旧的 | 浏览器缓存 HTML / CF 边缘缓存旧部署 | 本站 HTML 已设 `no-cache`（每次回源校验）；仍然旧就硬刷新 `Ctrl+F5`，Cloudflare 面板 **Caching → Purge Everything** |
| 改完 `_headers` 没生效 | 规则文件只在部署时解析 | 重新部署（GitHub 集成：重跑构建；CLI：重跑 `pages deploy`） |
| `/_astro/*` 改名后旧链接 404 | 哈希文件名本来就该换 | 正常现象：HTML 与资源必须同一次部署一起发 |
| 某张图/音频更新后还是旧的 | 素材给了 30 天/7 天缓存 | 换文件名（推荐），或临时调小 `public/_headers` 里的 `max-age` |
| 拖进度条总是从头播 | 平台对 Range 请求的处理差异 | Cloudflare 目前对 Range 返回 200（官方已知，处理中）；这是平台限制，不是配置问题 |

### 6.4 凭据与密钥（别把 token 写进这些地方）

| 规则 | 说明 |
|---|---|
| ✅ 只放 CI Secret / 面板环境变量 | GitHub Actions 用 `${{ secrets.CLOUDFLARE_API_TOKEN }}`（本仓库文件里**只有占位符**，没有真实值） |
| ❌ 不写进 `wrangler.jsonc` 的 `vars` | `vars` 是明文，会随部署下发到运行时环境 |
| ❌ 不加 `PUBLIC_` 前缀 | Astro 会把 `PUBLIC_*` 环境变量**内联进浏览器产物**；`PUBLIC_AUDIO_BASE_URL` 这类只适合放公开读地址 |
| ❌ 不提交 `.env` / `.dev.vars` | `.gitignore` 已忽略 `.env`、`.env.*`（保留 `.env.example`）；`.dev.vars` 若将来使用也要自行加入忽略 |
| 最小权限 | Pages/Workers 部署：Account → Cloudflare Pages / Workers Scripts **Edit** + Account Settings **Read**；构建期读 D1：D1 **Read**；`d1-push` 写库需要 D1 **Edit** |
| 构建期取 D1 的凭据 | `CONTENT_SOURCE=d1` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_D1_DATABASE_ID` + `CLOUDFLARE_API_TOKEN`（见 `scripts/lib/d1-client.mjs`） |
| 泄漏处理 | 立刻在 Cloudflare 面板 Rotate / 删除该 Token，再重跑部署；`ETag` 只是内容哈希，不算机密 |
| GitHub 侧 | `actions/deploy-pages` 用的是 OIDC（`id-token: write`）+ 内置 `GITHUB_TOKEN`，**不需要**个人 PAT |

> 补充（架构红线）：本站必须保持纯静态，**不引入运行时数据库、不上传接口**。
> D1 只允许出现在「构建期取数」这一环，且构建期只能用 REST API 或 `wrangler d1 export`，
> 因为 Pages/Workers 的 D1 binding 只在**运行时**可见：
> <https://developers.cloudflare.com/pages/functions/bindings/>

---

## 7. 与现有 nginx 部署的关系

| 关注点 | nginx（现有，`部署/nginx.conf` + `部署/部署指南.md`） | Cloudflare Pages / Workers | GitHub Pages |
|---|---|---|---|
| 谁来托管 | 自己的服务器 | Cloudflare 边缘 | GitHub |
| 缓存/响应头来自 | `nginx.conf` | `public/_headers` | 平台默认（不可改） |
| 404 行为 | `try_files $uri $uri/ =404` → 真 404 | 有无 `404.html` 决定（见 6.1） | GitHub 默认 404 页 |
| 字体 MIME | 配置里手动补 `types` 块 | `_headers` 里 `/*.ttf` | 不可控 |
| 部署方式 | `tar` + `scp` + 解压 | git push 自动构建 / CLI 上传 | git push 自动构建 |

要点：

1. **产物是同一份 `dist/`**，三处可以同时发布，互不冲突；内容更新仍然只改本地 SQLite 再 `pnpm build`。
2. `public/_headers`、`public/_redirects` 只对 Cloudflare 生效：
   - nginx 需要同样的策略请在 `部署/nginx.conf` 里维护（现有配置已经覆盖了 HTML 不缓存、`/_astro/` 长缓存、字体 MIME）；
   - GitHub Pages 一律不解析，服务器上会多出这两个文件，无害。
3. 本次部署配套改动**没有动** `部署/nginx.conf` 与 `部署/部署指南.md`，nginx 部署路径保持原样可用；
   子路径适配是主线在 `astro.config.mjs`、`src/lib/asset-url.ts` 与 4 处调用点上完成的（第 5 节）。
4. 迁移顺序建议：先让 Cloudflare Pages 跑通（根路径，最简单、零代码改动）→ 按 5.3 节验证一次子路径构建 →
   再开 GitHub Pages → nginx 留作内网/备用。

---

## 8. 官方文档链接汇总

| 主题 | 链接 |
|---|---|
| Pages：Wrangler 配置（`pages_build_output_dir`、source of truth、`wrangler` 版本要求） | <https://developers.cloudflare.com/pages/functions/wrangler-configuration/> |
| Pages：构建命令 / 输出目录 / 系统环境变量 | <https://developers.cloudflare.com/pages/configuration/build-configuration/> |
| Pages：构建镜像（Node 22 default、pnpm 10 default、`.node-version`、`PNPM_VERSION`、v3 限制） | <https://developers.cloudflare.com/pages/configuration/build-image/> |
| Pages：`_headers`（语法、splat、合并规则） | <https://developers.cloudflare.com/pages/configuration/headers/> |
| Pages：`_redirects`（语法、状态码支持、顺序） | <https://developers.cloudflare.com/pages/configuration/redirects/> |
| Pages：路由与 404 / SPA 兜底 / 默认响应头 | <https://developers.cloudflare.com/pages/configuration/serving-pages/> |
| Pages：直接上传（`wrangler pages deploy`） | <https://developers.cloudflare.com/pages/get-started/direct-upload/> |
| Pages：GitHub 集成 | <https://developers.cloudflare.com/pages/get-started/git-integration/> |
| Pages：Functions bindings（D1 binding 仅运行时） | <https://developers.cloudflare.com/pages/functions/bindings/> |
| Workers：静态资源总览（`assets.directory`、路由、缓存） | <https://developers.cloudflare.com/workers/static-assets/> |
| Workers：静态资源响应头 | <https://developers.cloudflare.com/workers/static-assets/headers/> |
| Workers：静态资源重定向 | <https://developers.cloudflare.com/workers/static-assets/redirects/> |
| Workers：SSG 路由与自定义 404（`not_found_handling`、`html_handling`） | <https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/> |
| Workers：从 Pages 迁移 + 兼容性对照表 | <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/> |
| Workers：Wrangler 命令 | <https://developers.cloudflare.com/workers/wrangler/commands/> |
| Workers：兼容日期 | <https://developers.cloudflare.com/workers/configuration/compatibility-dates/> |
| GitHub Pages：自定义工作流（权限块、artifact、deploy） | <https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages> |
| GitHub Pages：配置发布源（Source 选 GitHub Actions） | <https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site> |
| GitHub Pages：使用限制 | <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits> |
| GitHub Pages：自定义 404 | <https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site> |
| GitHub Pages：自定义域名 | <https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site> |
| GitHub Actions：`actions/upload-pages-artifact`（v5，`include-hidden-files`） | <https://github.com/actions/upload-pages-artifact> |
| GitHub Actions：`actions/deploy-pages`（v5） | <https://github.com/actions/deploy-pages> |
| GitHub Actions：`pnpm/action-setup`（v6） | <https://github.com/pnpm/action-setup> |
| Astro：`base` 配置 | <https://docs.astro.build/en/reference/configuration-reference/#base> |
| Astro：环境变量（`import.meta.env.BASE_URL`、`PUBLIC_` 前缀会被内联） | <https://docs.astro.build/en/guides/environment-variables/> |
| Node：`node:sqlite` 版本历史（22.13 起无需 `--experimental-sqlite`） | <https://nodejs.org/docs/latest-v22.x/api/sqlite.html> |

---

## 9. 本次未能实测的事项

诚实地列出来，避免把「配置写完了」当成「验证过了」：

| 事项 | 状态 |
|---|---|
| Cloudflare Pages 真实部署（GitHub 集成 / `wrangler pages deploy`） | ❌ **未实测**：没有 Cloudflare 账号与凭据 |
| Cloudflare Workers `wrangler deploy`（`wrangler.worker.jsonc` 只是示例） | ❌ **未实测**：同上；这份配置也**没有**写进仓库 |
| GitHub Pages 真实发布 | ❌ **未跑通**：workflow 只做了语法与版本核对，未在真实仓库触发 |
| `SITE_BASE` / `SITE_URL` 生效 | ⚠️ **代码已落地、但没实测**：`astro.config.mjs` 已读取，沙盒内跑不了 `astro build`（见下方说明） |
| `_headers` 能否覆盖 `.ttf` 的 `Content-Type` | ⚠️ **未实测**：规则按官方语法写，上线后用 `curl -I` 复核（见 6.2） |
| `_redirects` 的 301 实际响应 | ⚠️ **未实测**：需上线后 `curl -I .../about` 看 `location` |
| 构建期 D1 REST 取数 | ⚠️ 仅有 mock 单测（见交接材料），无真实 D1 库 |

> **沙盒限制（不是仓库问题）**：本会话里 `pnpm test` 与 `pnpm build` 都在**启动子进程**时被拒绝
> （`node --test` 会为每个测试文件 spawn 子进程；Astro/Vite 在 Windows 上也要 spawn 一次做路径解析）。
> 绕过办法：`node --test --experimental-test-isolation=none <测试文件…>` 可以在同进程内跑完
> （本次 71 个用例全绿）；`astro build` 没有等价开关，需要在沙盒外或有权限的环境跑。
>
> 已经实际确认过的：
> - `data/content.db` 与 `src/data/content.json` 都在 git 里（云构建必须能读到它们）；
> - `src/data/content.json` 的 SHA256 在本次改动前后未变（`3BD9991F…CFD4B10D`）；
> - `.github/workflows/deploy.yml` 用 JavaScript 的 YAML 解析器（js-yaml）解析通过，且权限块、
>   步骤顺序（checkout → pnpm → node → install → test → build → upload → deploy）、
>   `needs` / `environment` / 版本号都做了断言检查；
> - `wrangler.jsonc` 去掉注释后是合法 JSON，`name` / `compatibility_date` / `pages_build_output_dir` 取值正确；
> - `public/_headers` 与 `public/_redirects` 的规则行格式逐行核对通过，`_redirects` 里没有 SPA 通配 200。
