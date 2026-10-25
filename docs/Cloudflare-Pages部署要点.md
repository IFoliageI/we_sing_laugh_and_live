# Cloudflare Pages 部署要点

> 一页速查卡。完整说明见 [部署-Cloudflare-GitHubPages.md](部署-Cloudflare-GitHubPages.md)，日常改内容的操作见 [修改与部署手册](修改与部署手册.md)。
> 本站是**纯静态站**：产物是 `dist/`，没有任何运行时数据库或 Functions。

---

## 1. 前置条件（三样必须一致）

| 项 | 本仓库的值 | 说明 |
|---|---|---|
| Pages 项目名 | `we-sing-laugh-and-live` | 与 `wrangler.jsonc` 的 `name` **必须一致**；只允许小写字母/数字/连字符（**不能有下划线**） |
| 构建命令 | `pnpm build` | 内部先跑 `content-sync` 再从 `data/content.db` 生成 JSON，然后 `astro build` |
| 输出目录 | `dist` | 对应 `wrangler.jsonc` 的 `pages_build_output_dir` |

## 2. 构建环境（最容易踩的坑）

| 项 | Cloudflare 默认 | 本仓库要求 |
|---|---|---|
| Node | 22.16.0 | **24.19.0** —— 仓库里有 `.node-version`，Pages 会自动读 |
| pnpm | **10.11.1** | **11.21.0** —— ⚠️ Pages **不会**从 `pnpm-lock.yaml` 推断版本，必须在环境变量里设 `PNPM_VERSION=11.21.0` |

在 Pages 项目的 **Settings → Environment variables** 里加：

```
PNPM_VERSION = 11.21.0
```

否则锁文件版本不匹配，构建可能失败或装出错误的依赖树。

## 3. 两条部署路径

### A. GitHub 集成（推荐，推代码即构建）

1. Cloudflare 面板 → Workers & Pages → Create → Pages → Connect to Git → 选本仓库
2. 框架预设选 **Astro**，构建命令 `pnpm build`，输出目录 `dist`
3. 环境变量加 `PNPM_VERSION=11.21.0`
4. 之后每次推送到生产分支都会自动构建部署

> ⚠️ 本仓库的 `.github/workflows/deploy.yml` 是给 **GitHub Pages** 用的，且当前**仅手动触发**；它和 Cloudflare 的 Pages 构建互不影响。

### B. 命令行（最快，用本地已构建的产物）

```powershell
npx wrangler@latest login                     # 浏览器授权（OAuth）
npx wrangler@latest pages project create we-sing-laugh-and-live --production-branch Online
pnpm build
npx wrangler@latest pages deploy dist --project-name we-sing-laugh-and-live
```

`wrangler pages deploy` 是**直接上传 `dist/`**，不会在云端构建 —— 所以本地必须先 `pnpm build` 成功。

## 4. 仓库里已经配好的东西（不用再动）

| 文件 | 作用 |
|---|---|
| `wrangler.jsonc` | Pages 项目名 / 兼容日期 / 输出目录；**D1 binding 刻意不启用** |
| `.node-version` | 固定 Node 24.19.0 |
| `public/_headers` | 缓存与安全响应头：HTML 不缓存、`/_astro/*` 一年不可变、`*.ttf` 的 `Content-Type: font/ttf` |
| `public/_redirects` | 只做明确 301（`/request` → `/request/` 等），**没有** `/* /index.html 200`（会吞掉真 404） |
| `src/pages/404.astro` | 构建出 `dist/404.html`，让未知路径返回真 404 |

`_headers` / `_redirects` 在 **Pages 和 Workers 静态资源**里都生效；GitHub Pages 完全不解析它们。

## 5. 根路径 vs 子路径

| 部署形态 | 要不要设 `SITE_BASE` |
|---|---|
| `xxx.pages.dev`（项目根） | **不设**（不设 = 根路径，行为与现在完全一致） |
| 自定义域名绑在根 | 不设 |
| 挂在某个子路径（如 `/music/`） | 设 `SITE_BASE=/music/` 再构建，同时 `public/_redirects` 的规则要做相应调整 |

设了 `SITE_URL`（如 `https://example.com`）会写进 Astro 的 `site`，用于生成绝对 URL / SEO 信息；不设也不影响站点运行。

## 6. 五个高频坑

1. **项目名带下划线** → Pages 直接拒绝。用 `we-sing-laugh-and-live`。
2. **忘了 `PNPM_VERSION`** → 云端用 pnpm 10.11.1 装 11.21.0 生成的锁文件，可能失败。
3. **`wrangler.jsonc` 存在时它是「唯一配置来源」** —— 用 GitHub 集成后，面板里同名/同类字段变成只读。改配置要改文件后重新部署。
4. **D1 binding 只在 Functions 运行时可见**（`context.env.DB`），`astro build` 阶段拿不到它。本站构建期读本地 SQLite；若要从远程 D1 取数，只能走 D1 REST（见 [D1构建期数据源](D1构建期数据源.md)）。
5. **没有 `404.html` 时**，Pages 会把未知路径回落到首页并返回 **200**。本仓库已加 `src/pages/404.astro` 解决。

## 7. 上线检查清单

- [ ] `pnpm test` 全绿（当前 81 例）
- [ ] `pnpm build` 成功，且 `dist/` 里有 `index.html`、`request/index.html`、`about/index.html`、`404.html`、`_headers`、`_redirects`
- [ ] `dist/` 里**没有** `.env`、`*.db`、`*.sql`、日志（构建产物只应有静态文件）
- [ ] Pages 项目名与 `wrangler.jsonc` 的 `name` 一致
- [ ] 环境变量已设 `PNPM_VERSION=11.21.0`
- [ ] 部署后逐个访问：首页 `/`、`/request/`、`/about/`、任意不存在的路径（应 404）
- [ ] 抽查字体与图标：`/fonts/SegoeFluentIcons.ttf` 返回 `font/ttf`，`/icons/*` 可访问
- [ ] 手机上打开一遍，确认导航抽屉、主题切换、音频播放正常
- [ ] 音频文件确实已放进 `public/audio/<分组>/` 并已 `pnpm build`（否则按钮点了会报文件不存在）

## 8. 回滚

| 场景 | 做法 |
|---|---|
| 只是这次部署有问题 | Cloudflare 面板 → 该项目 → Deployments → 找上一个可用部署 → **Rollback** |
| 想回到某个提交 | `git checkout <commit>` → `pnpm build` → 重新 `wrangler pages deploy` |
| 内容错了（音频/条目） | 改 `data/content.db` 后重新构建部署；或从 `data/backups/` 恢复数据库（见手册第 3.7 节） |

## 9. 相关文档

- [部署-Cloudflare-GitHubPages.md](部署-Cloudflare-GitHubPages.md) —— 三平台完整说明（Pages / Workers / GitHub Pages）
- [修改与部署手册.md](修改与部署手册.md) —— 日常改内容与部署的步骤化手册
- [D1构建期数据源.md](D1构建期数据源.md) —— 可选的远程内容源
- 官方：[Pages 构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/) · [构建镜像与版本覆盖](https://developers.cloudflare.com/pages/configuration/build-image/) · [Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) · [Serving Pages（404 行为）](https://developers.cloudflare.com/pages/configuration/serving-pages/)
