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
import path from 'node:path';
import { openDb, loadSection, exportDump, writeIfChanged, CONTENT_JSON, DATA_DIR, SECTIONS } from './lib/db.mjs';

function syncContent(db) {
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

    let itemCount = 0;
    let stackCount = 0;
    const groups = [...data.groups, ...(data.secretGroup ? [data.secretGroup] : [])];
    for (const group of groups) {
      itemCount += group.voices.length + (group.hiddenVoices?.length ?? 0);
      for (const stack of group.stacks ?? []) {
        itemCount += stack.voices.length;
        stackCount++;
      }
    }
    summary.push({ label: SECTIONS[section].label, groupCount: groups.length, itemCount, stackCount });
  }

  const target = path.relative(process.cwd(), CONTENT_JSON).split(path.sep).join('/');
  if (writeIfChanged(CONTENT_JSON, JSON.stringify(content, null, 2) + '\n')) {
    console.log(`✓ 已生成 ${target}`);
  } else {
    console.log(`· 内容无变化（${target} 已是最新）`);
  }
  for (const entry of summary) {
    console.log(
      `    ${entry.label}：${entry.groupCount} 个分组 / ${entry.itemCount} 条音频` +
        (entry.stackCount ? ` / ${entry.stackCount} 个合集` : '')
    );
  }
  if (exportDump(db, path.join(DATA_DIR, 'content-dump.sql'))) {
    console.log('✓ 已更新 data/content-dump.sql（内容快照，便于 git diff）');
  }
}

const db = openDb({ readOnly: true });
try {
  // 一个读事务保证 JSON 和 SQL 快照来自同一版本，兼容桌面工具同时编辑。
  db.exec('BEGIN;');
  syncContent(db);
  db.exec('COMMIT;');
} finally {
  db.close();
}
