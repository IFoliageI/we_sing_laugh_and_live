// ============================================================
//  内容同步：data/content.db  →  src/data/content.json
//
//  用法：
//      node scripts/content-sync.mjs
//
//  - 每次 pnpm build / pnpm dev 都会自动先跑一遍，保证 JSON 与数据库一致。
//  - 内容没变化时不会改写文件（避免无意义的 git 改动与时间戳抖动）。
//  - 生成结果里不含时间戳，方便 git diff 审阅。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { openDb, loadSection, exportDump, CONTENT_JSON, DATA_DIR, SECTIONS } from './lib/db.mjs';

const db = openDb();

const content = {
  _generated: {
    note: '本文件由 scripts/content-sync.mjs 自动生成，请勿手工编辑；内容源是 data/content.db',
    source: 'data/content.db',
  },
};

const summary = [];
for (const section of Object.keys(SECTIONS)) {
  const data = loadSection(db, section);
  content[section] = {
    hint: data.hint,
    groups: data.groups,
    ...(data.secretGroup ? { secretGroup: data.secretGroup } : {}),
  };

  const count = (arr) => arr.length;
  const groupCount = count(data.groups) + (data.secretGroup ? 1 : 0);
  let itemCount = 0;
  let stackCount = 0;
  const tally = (g) => {
    itemCount += g.voices.length + (g.hiddenVoices?.length ?? 0);
    for (const s of g.stacks ?? []) {
      itemCount += s.voices.length;
      stackCount++;
    }
  };
  data.groups.forEach(tally);
  if (data.secretGroup) tally(data.secretGroup);

  summary.push({ section, label: SECTIONS[section].label, groupCount, itemCount, stackCount });
}

const next = JSON.stringify(content, null, 2) + '\n';
const prev = fs.existsSync(CONTENT_JSON) ? fs.readFileSync(CONTENT_JSON, 'utf8') : null;

const target = path.relative(process.cwd(), CONTENT_JSON).split(path.sep).join('/');

if (prev === next) {
  console.log(`· 内容无变化（${target} 已是最新）`);
} else {
  fs.mkdirSync(path.dirname(CONTENT_JSON), { recursive: true });
  fs.writeFileSync(CONTENT_JSON, next, 'utf8');
  console.log(`✓ 已生成 ${target}`);
}

for (const s of summary) {
  console.log(
    `    ${s.label}：${s.groupCount} 个分组 / ${s.itemCount} 条音频` +
      (s.stackCount ? ` / ${s.stackCount} 个合集` : '')
  );
}

// 同时导出纯文本 SQL 快照：SQLite 是二进制，git 无法审阅差异，
// 有了它「这次内容改了什么」在 git diff 里就能直接看到。
const dumpFile = path.join(DATA_DIR, 'content-dump.sql');
if (exportDump(db, dumpFile)) console.log('✓ 已更新 data/content-dump.sql（内容快照，便于 git diff）');

db.close();
