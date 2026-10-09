// ============================================================
//  构建产物回归校验
//
//  用法：pnpm content:verify      （需先 pnpm build）
//
//  验证「数据库里的内容是否都正确进入了构建产物」：
//    ① 首屏 HTML 里应有：普通分组标题、合集标题、独立按钮文字
//    ② JS bundle 里应有：全部条目（彩蛋音频 / 合集成员 / 音频路径 / 悬停卡片字段）
//       —— 这些按设计不进首屏 HTML：彩蛋要解锁才渲染，合集只显示随机中的那一条
//
//  用途：改完内容后跑一次，能立刻发现「数据写了但没生效」这类问题。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT_JSON } from './lib/db.mjs';
import { verifyContent } from './lib/content-verification.mjs';

const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('✗ 找不到 dist/，请先执行 pnpm build');
  process.exit(1);
}
if (!fs.existsSync(CONTENT_JSON)) {
  console.error('✗ 找不到 src/data/content.json，请先执行 pnpm content:sync');
  process.exit(1);
}

const content = JSON.parse(fs.readFileSync(CONTENT_JSON, 'utf8'));

const html = {
  voice: fs.readFileSync(path.join(DIST, 'index.html'), 'utf8'),
  song: fs.readFileSync(path.join(DIST, 'request', 'index.html'), 'utf8'),
};

const jsDir = path.join(DIST, '_astro');
const allJs =
  fs
    .readdirSync(jsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(jsDir, f), 'utf8'))
    .join('\n');
const { itemCount, fieldCount, problems } = verifyContent(content, html, allJs);

console.log(`条目校验：${itemCount} 条 / 字段校验：${fieldCount} 个`);

if (problems.length === 0) {
  console.log('✓ 全部内容都正确进入了构建产物（首屏 HTML + JS bundle）');
} else {
  console.log(`\n✗ 有 ${problems.length} 处问题：`);
  problems.slice(0, 20).forEach((p) => console.log('   ' + p));
  process.exit(1);
}
