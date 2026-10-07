// ============================================================
//  一次性迁移：把 src/data/voices.ts 与 songs.ts 的现有内容导入 SQLite
//
//  用法：
//      node scripts/content-migrate.mjs            # 首次创建 data/content.db
//      node scripts/content-migrate.mjs --force    # 覆盖重建（会清空现有内容！）
//
//  说明：
//  - 现有数据全部是占位「示例」，因此入库时统一打上 is_example = 1，
//    以后可用 `pnpm content:rm-examples -- --yes` 一键清除。
//  - 分组（悲鸣 / 怪叫 / ACG …）属于结构性骨架，不打示例标记。
//  - Node 会直接类型擦除地导入 .ts，因此迁移是「零转录误差」的。
// ============================================================
import fs from 'node:fs';
import { openDb, setSetting, DB_PATH } from './lib/db.mjs';

const force = process.argv.includes('--force');

if (fs.existsSync(DB_PATH)) {
  if (!force) {
    console.error(`✗ 数据库已存在：${DB_PATH}`);
    console.error('  如需覆盖重建，请加 --force（会清空现有内容）');
    process.exit(1);
  }
  fs.rmSync(DB_PATH);
  console.log('· 已删除旧数据库（--force）');
}

// 直接导入现有 TS 数据（Node 原生类型擦除）
const voicesMod = await import('../src/data/voices.ts');
const songsMod = await import('../src/data/songs.ts');

const db = openDb({ create: true });

const insGroup = db.prepare(
  'INSERT INTO groups (section, group_name, title, sort_order, is_secret) VALUES (?, ?, ?, ?, ?)'
);
const insStack = db.prepare(
  'INSERT INTO stacks (group_id, title, sort_order, is_example) VALUES (?, ?, ?, 1)'
);
const insItem = db.prepare(
  `INSERT INTO items (group_id, stack_id, kind, path, zh, artist,
                      info_time, info_title, info_note, info_thumb, sort_order, is_example)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
);

let nGroups = 0;
let nStacks = 0;
let nItems = 0;

/** 插入一条音频（stackId 为 null 表示独立按钮） */
function addItem(groupId, stackId, kind, v, order) {
  const info = v.info ?? {};
  insItem.run(
    groupId,
    stackId,
    kind,
    v.path,
    v.zh,
    v.artist ?? null,
    info.time ?? null,
    info.title ?? null,
    info.note ?? null,
    info.thumb ?? null,
    order
  );
  nItems++;
}

/** 插入一个分组（含 voices / stacks / hiddenVoices） */
function addGroup(section, g, order, isSecret = 0) {
  const r = insGroup.run(section, g.groupName, g.title, order, isSecret);
  const gid = Number(r.lastInsertRowid);
  nGroups++;

  (g.voices ?? []).forEach((v, i) => addItem(gid, null, 'normal', v, i));

  (g.stacks ?? []).forEach((s, si) => {
    const sr = insStack.run(gid, s.title ?? null, si);
    const sid = Number(sr.lastInsertRowid);
    nStacks++;
    (s.voices ?? []).forEach((v, i) => addItem(gid, sid, 'normal', v, i));
  });

  (g.hiddenVoices ?? []).forEach((v, i) => addItem(gid, null, 'hidden', v, i));

  return gid;
}

// ---------- 首页「渺の怪动静」 ----------
voicesMod.voiceGroups.forEach((g, i) => addGroup('voice', g, i));
if (voicesMod.secretGroup) {
  addGroup('voice', voicesMod.secretGroup, voicesMod.voiceGroups.length, 1);
}
setSetting(db, 'voice_empty_hint', voicesMod.EMPTY_HINT);

// ---------- 歌单页「渺の歌单」 ----------
songsMod.songGroups.forEach((g, i) => addGroup('song', g, i));
setSetting(db, 'song_empty_hint', songsMod.SONG_EMPTY_HINT);

console.log('');
console.log('✓ 迁移完成');
console.log(`  数据库    : ${DB_PATH}`);
console.log(`  分组      : ${nGroups}`);
console.log(`  合集      : ${nStacks}`);
console.log(`  音频条目  : ${nItems}（全部标记为示例，可一键清除）`);
console.log('');
console.log('下一步：node scripts/content-sync.mjs   生成 src/data/content.json');
