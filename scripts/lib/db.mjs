// ============================================================
//  内容数据库共享工具
//  - 打开 data/content.db
//  - 读取分组 / 合集 / 条目，拼装成前端需要的结构
//  - 供 content-sync.mjs / content-cli.mjs / content-migrate.mjs 复用
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'content.db');
export const SCHEMA_PATH = path.join(DATA_DIR, 'schema.sql');
export const CONTENT_JSON = path.join(ROOT, 'src', 'data', 'content.json');
export const AUDIO_DIR = path.join(ROOT, 'public', 'audio');

/** 两个栏目的元信息 */
export const SECTIONS = {
  voice: { label: '渺の怪动静（首页）', hintKey: 'voice_empty_hint' },
  song: { label: '渺の歌单（/request）', hintKey: 'song_empty_hint' },
};

/** 打开数据库；create=true 时会先建表 */
export function openDb({ create = false } = {}) {
  if (!create && !fs.existsSync(DB_PATH)) {
    throw new Error(
      `数据库不存在：${DB_PATH}\n` +
        `请先执行迁移：node scripts/content-migrate.mjs`
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  if (create) db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** 把一行 item 转成前端 Voice 结构（空字段不输出，保持 JSON 干净） */
function toVoice(row) {
  const voice = { path: row.path, zh: row.zh };
  if (row.artist) voice.artist = row.artist;
  const info = {};
  if (row.info_time) info.time = row.info_time;
  if (row.info_title) info.title = row.info_title;
  if (row.info_note) info.note = row.info_note;
  if (row.info_thumb) info.thumb = row.info_thumb;
  if (Object.keys(info).length > 0) voice.info = info;
  return voice;
}

/** 读取一个栏目，拼装成 { hint, groups, secretGroup } */
export function loadSection(db, section) {
  const groupRows = db
    .prepare('SELECT * FROM groups WHERE section = ? ORDER BY sort_order, id')
    .all(section);

  const stackStmt = db.prepare('SELECT * FROM stacks WHERE group_id = ? ORDER BY sort_order, id');
  const itemStmt = db.prepare(
    "SELECT * FROM items WHERE group_id = ? AND kind = 'normal' ORDER BY sort_order, id"
  );
  const hiddenStmt = db.prepare(
    "SELECT * FROM items WHERE group_id = ? AND kind = 'hidden' ORDER BY sort_order, id"
  );

  const groups = [];
  let secretGroup = null;

  for (const g of groupRows) {
    const normals = itemStmt.all(g.id);
    const hiddens = hiddenStmt.all(g.id);
    const stacks = stackStmt.all(g.id).map((s) => {
      const obj = {};
      if (s.title) obj.title = s.title;
      obj.voices = normals.filter((i) => i.stack_id === s.id).map(toVoice);
      return obj;
    });

    const node = { groupName: g.group_name, title: g.title, voices: normals.filter((i) => i.stack_id === null).map(toVoice) };
    if (stacks.length > 0) node.stacks = stacks;
    if (hiddens.length > 0) node.hiddenVoices = hiddens.map(toVoice);

    if (g.is_secret) secretGroup = node;
    else groups.push(node);
  }

  return { hint: getSetting(db, SECTIONS[section].hintKey) ?? '', groups, secretGroup };
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/** 每个分组的条目统计（给 stats 命令用） */
export function groupStats(db, section) {
  return db
    .prepare(
      `SELECT g.id, g.group_name, g.title, g.is_secret, g.sort_order,
              (SELECT COUNT(*) FROM items i WHERE i.group_id = g.id AND i.kind = 'normal' AND i.stack_id IS NULL) AS singles,
              (SELECT COUNT(*) FROM items i WHERE i.group_id = g.id AND i.kind = 'normal' AND i.stack_id IS NOT NULL) AS stack_members,
              (SELECT COUNT(*) FROM items i WHERE i.group_id = g.id AND i.kind = 'hidden') AS hiddens,
              (SELECT COUNT(*) FROM stacks s WHERE s.group_id = g.id) AS stacks,
              (SELECT COUNT(*) FROM items i WHERE i.group_id = g.id AND i.is_example = 1) AS examples
       FROM groups g WHERE g.section = ? ORDER BY g.sort_order, g.id`
    )
    .all(section);
}

/** 扫描 public/audio 下的所有音频文件，返回相对路径数组 */
export function listAudioFiles() {
  const exts = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(AUDIO_DIR, full).split(path.sep).join('/'));
      }
    }
  };
  walk(AUDIO_DIR);
  return out.sort();
}

/**
 * 把整个数据库导出为 .sql 文本。
 * 作用：SQLite 是二进制、git 无法审阅差异；导出的 SQL 是纯文本，
 *       每次 sync 都会重新生成，于是「内容改了什么」在 git diff 里一目了然。
 * 也能用于备份或重建：sqlite3 data/content.db < data/content-dump.sql
 */
export function exportDump(db, filePath) {
  const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const lines = [
    '-- ============================================================',
    '--  内容快照（由 scripts/content-sync.mjs 自动生成，请勿手工编辑）',
    '--  内容源是 data/content.db；本文件用于 git diff 审阅 / 备份。',
    '--  重建：sqlite3 data/content.db < data/content-dump.sql',
    '-- ============================================================',
    'PRAGMA foreign_keys = ON;',
    'BEGIN;',
    'DELETE FROM items; DELETE FROM stacks; DELETE FROM groups; DELETE FROM settings;',
  ];
  for (const g of db.prepare('SELECT * FROM groups ORDER BY id').all()) {
    lines.push(
      `INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES (${g.id}, ${q(g.section)}, ${q(g.group_name)}, ${q(g.title)}, ${g.sort_order}, ${g.is_secret});`
    );
  }
  for (const s of db.prepare('SELECT * FROM stacks ORDER BY id').all()) {
    lines.push(
      `INSERT INTO stacks (id, group_id, title, sort_order, is_example) VALUES (${s.id}, ${s.group_id}, ${q(s.title)}, ${s.sort_order}, ${s.is_example});`
    );
  }
  for (const i of db.prepare('SELECT * FROM items ORDER BY id').all()) {
    lines.push(
      `INSERT INTO items (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note, info_thumb, sort_order, is_example) VALUES (${i.id}, ${i.group_id}, ${i.stack_id ?? 'NULL'}, ${q(i.kind)}, ${q(i.path)}, ${q(i.zh)}, ${q(i.artist)}, ${q(i.info_time)}, ${q(i.info_title)}, ${q(i.info_note)}, ${q(i.info_thumb)}, ${i.sort_order}, ${i.is_example});`
    );
  }
  for (const s of db.prepare('SELECT * FROM settings ORDER BY key').all()) {
    lines.push(`INSERT INTO settings (key, value) VALUES (${q(s.key)}, ${q(s.value)});`);
  }
  lines.push('COMMIT;', '');

  const next = lines.join('\n');
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === next) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}
