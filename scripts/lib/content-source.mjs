// ============================================================
//  内容数据源抽象：本地 SQLite（默认） vs Cloudflare D1（构建期 REST）
//
//  背景（架构红线）：
//   · 站点是纯静态站点，SQLite 只用于本地内容管理与构建；
//   · D1 只允许在 **构建期** 通过 REST 读取（Pages 的 D1 binding 只在运行时可见，
//     `astro build` 阶段拿不到 binding），所以绝不能引入运行时数据库/接口。
//
//  用法：
//   · 默认（不设环境变量）：与改造前完全一致，走 data/content.db；
//   · CONTENT_SOURCE=d1：构建期从 D1 REST 取数（凭据见 d1-client.mjs）。
//
//  两种实现都产出与 db.mjs 的 loadSection() 完全同形状的数据：
//     { hint: string, groups: [...], secretGroup?: {...} }
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ROOT,
  DATA_DIR,
  DB_PATH,
  SCHEMA_PATH,
  SECTIONS,
  openDb,
  loadSection,
  exportDump,
} from './db.mjs';
import { createD1ClientFromEnv, D1ConfigError } from './d1-client.mjs';

/** 选择数据源的环境变量名。 */
export const CONTENT_SOURCE_ENV = 'CONTENT_SOURCE';

/** 支持的数据源模式。 */
export const SOURCE_MODES = Object.freeze({ local: 'local', d1: 'd1' });

/**
 * 读取并校验数据源模式；默认 local。
 * @param {Record<string, string|undefined>} [env]
 * @returns {'local'|'d1'}
 */
export function resolveSourceMode(env = process.env) {
  const raw = String(env?.[CONTENT_SOURCE_ENV] ?? '').trim().toLowerCase();
  if (raw === '' || raw === SOURCE_MODES.local) return SOURCE_MODES.local;
  if (raw === SOURCE_MODES.d1) return SOURCE_MODES.d1;
  throw new Error(
    `未知的 ${CONTENT_SOURCE_ENV}="${raw}"，只支持 local（默认，读 data/content.db）或 d1（构建期从 Cloudflare D1 REST 读取）。`
  );
}

function assertSection(section) {
  if (!Object.prototype.hasOwnProperty.call(SECTIONS, section)) {
    throw new Error(`未知栏目：${section}（只支持 ${Object.keys(SECTIONS).join(' / ')}）。`);
  }
}

/** 行 → 前端 Voice 结构（与 db.mjs 的 toVoice 必须保持一致：空字段不输出）。 */
export function toVoiceRow(row) {
  const voice = { path: row.path, zh: row.zh };
  if (row.artist) voice.artist = row.artist;
  // 旧库可能没有 special_effect 列，undefined 视为未设置
  if (row.special_effect) voice.specialEffect = true;
  const info = {};
  if (row.info_time) info.time = row.info_time;
  if (row.info_title) info.title = row.info_title;
  if (row.info_note) info.note = row.info_note;
  if (row.info_thumb) info.thumb = row.info_thumb;
  if (typeof row.info_duration === 'number' && Number.isFinite(row.info_duration) && row.info_duration >= 0) {
    info.duration = row.info_duration;
  }
  if (typeof row.info_uploader === 'string' && row.info_uploader.trim()) info.uploader = row.info_uploader.trim();
  if (typeof row.info_songcut_text === 'string' && row.info_songcut_text.trim()) {
    info.songCutText = row.info_songcut_text.trim();
  }
  if (Object.keys(info).length > 0) voice.info = info;
  return voice;
}

/** 排序键：与 SQL 的 `ORDER BY sort_order, id` 完全一致。 */
function byOrder(a, b) {
  const order = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  if (order !== 0) return order;
  return (a.id ?? 0) - (b.id ?? 0);
}

/**
 * 把三张表的行拼装成 loadSection() 的返回形状。
 * 这是 D1 模式与单元测试共用的纯函数；local 模式直接调用 db.mjs 的 loadSection()，
 * 不走这里，以保证默认路径 100% 不变。
 *
 * @param {object} input
 * @param {Array<object>} input.groupRows  某栏目的 groups 行
 * @param {Array<object>} [input.stackRows] 这些分组下的 stacks 行
 * @param {Array<object>} [input.itemRows]  这些分组下的 items 行
 * @param {string} [input.hint]            空栏目提示文案
 */
export function assembleSection({ groupRows = [], stackRows = [], itemRows = [], hint = '' } = {}) {
  const groups = [];
  let secretGroup = null;

  const groupIds = new Set(groupRows.map((group) => group.id));
  const stacksByGroup = new Map();
  for (const stack of [...stackRows].filter((stack) => groupIds.has(stack.group_id)).sort(byOrder)) {
    if (!stacksByGroup.has(stack.group_id)) stacksByGroup.set(stack.group_id, []);
    stacksByGroup.get(stack.group_id).push(stack);
  }

  const itemsByGroup = new Map();
  for (const item of [...itemRows].filter((item) => groupIds.has(item.group_id)).sort(byOrder)) {
    if (!itemsByGroup.has(item.group_id)) itemsByGroup.set(item.group_id, []);
    itemsByGroup.get(item.group_id).push(item);
  }

  for (const group of [...groupRows].sort(byOrder)) {
    const items = itemsByGroup.get(group.id) ?? [];
    const normals = items.filter((item) => item.kind === 'normal');
    const hiddens = items.filter((item) => item.kind === 'hidden');

    const stacks = (stacksByGroup.get(group.id) ?? []).map((stack) => {
      const node = {};
      if (stack.title) node.title = stack.title;
      node.voices = normals.filter((item) => item.stack_id === stack.id).map(toVoiceRow);
      return node;
    });

    const node = {
      groupName: group.group_name,
      title: group.title,
      voices: normals.filter((item) => item.stack_id === null || item.stack_id === undefined).map(toVoiceRow),
    };
    if (stacks.length > 0) node.stacks = stacks;
    if (hiddens.length > 0) node.hiddenVoices = hiddens.map(toVoiceRow);

    if (group.is_secret) secretGroup = node;
    else groups.push(node);
  }

  return { hint: hint ?? '', groups, secretGroup };
}

/**
 * 本地 SQLite 数据源（默认）。
 * 保持改造前的行为：只读连接 + 一个读事务，保证 content.json 与 content-dump.sql 来自同一版本。
 *
 * ⚠ 连接所有权：
 *   · 不注入 db 时（正常构建路径），连接与读事务都由本对象创建，close() 会提交只读事务并关闭连接；
 *   · 注入 db 时（测试 / 特殊调用方），连接所有权归调用方：本对象不开读事务（调用方可能已经
 *     开了自己的事务），close() 也不会提交或关闭它，否则会毁掉调用方后续的查询。
 */
export function createLocalContentSource({ db = null, dbPath = DB_PATH } = {}) {
  const ownConnection = !db;
  const ownDb = db ?? openDb({ readOnly: true, dbPath });
  let closed = false;

  if (ownConnection) ownDb.exec('BEGIN;');

  return {
    mode: SOURCE_MODES.local,
    describe: () => `local（${path.relative(ROOT, dbPath).split(path.sep).join('/') || 'data/content.db'}）`,
    async loadSection(section) {
      assertSection(section);
      return loadSection(ownDb, section);
    },
    async writeDump(targetPath) {
      return exportDump(ownDb, targetPath);
    },
    close() {
      if (closed) return;
      closed = true;
      if (!ownConnection) return;
      try {
        ownDb.exec('COMMIT;');
      } catch {
        // 只读事务提交失败不影响任何数据，忽略
      } finally {
        ownDb.close();
      }
    },
  };
}

/** 需要从 D1 取回本地的表（顺序即插入顺序，父表在前，满足外键）。 */
export const D1_DUMP_TABLES = Object.freeze([
  { name: 'groups', orderBy: 'id', optional: false },
  { name: 'stacks', orderBy: 'id', optional: false },
  { name: 'items', orderBy: 'id', optional: false },
  { name: 'settings', orderBy: 'key', optional: false },
  { name: 'item_audio', orderBy: 'item_id', optional: true },
  { name: 'audio_cleanup', orderBy: 'asset_json', optional: true },
  { name: 'audio_retired', orderBy: 'asset_json', optional: true },
]);

function localTableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

/**
 * 把 D1 上的数据物化成一个内存 SQLite 库，然后交给 db.mjs 的 exportDump() 生成快照。
 * 这样做的好处：D1 模式生成的 data/content-dump.sql 与本地模式**完全同一套格式**，
 * 不需要再写一份 SQL 序列化逻辑（少一处漂移风险）。
 * @returns {Promise<import('node:sqlite').DatabaseSync>} 调用方负责 close()
 */
export async function materializeD1Snapshot(client, { schemaPath = SCHEMA_PATH, tables = D1_DUMP_TABLES } = {}) {
  if (!client) throw new Error('materializeD1Snapshot 需要 D1 客户端。');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));

  try {
    for (const { name, orderBy, optional } of tables) {
      if (!localTableExists(db, name)) continue;

      let rows;
      try {
        rows = await client.selectAll(`SELECT * FROM ${name} ORDER BY ${orderBy}`);
      } catch (error) {
        if (optional) continue; // 远端的私有目录表可能还没建，跳过即可
        throw error;
      }
      if (rows.length === 0) continue;

      const columns = db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((column) => column.name);
      // 远端可能是旧 schema：只写两边都有的列，避免 INSERT 报未知列
      const usable = columns.filter((column) => Object.prototype.hasOwnProperty.call(rows[0], column));
      if (usable.length === 0) continue;

      const statement = db.prepare(
        `INSERT OR REPLACE INTO ${name} (${usable.join(', ')}) VALUES (${usable.map(() => '?').join(', ')})`
      );
      for (const row of rows) statement.run(...usable.map((column) => row[column] ?? null));
    }

    // 让快照里的自增序列与 D1 一致（exportDump 会导出 sqlite_sequence）。
    try {
      const sequences = await client.selectAll(
        "SELECT name, seq FROM sqlite_sequence WHERE name IN ('groups', 'stacks', 'items') ORDER BY name"
      );
      const statement = db.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      for (const sequence of sequences) statement.run(sequence.name, sequence.seq);
    } catch {
      // 某些 D1 版本不允许查询 sqlite_sequence：忽略即可，快照仍然可用
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * D1 数据源（构建期只读）。
 * 每个栏目用 4 个查询：分组 / 合集 / 条目 / 空提示，然后交给 assembleSection() 拼装。
 */
export function createD1ContentSource({ client, logger = console } = {}) {
  if (!client) throw new Error('createD1ContentSource 需要 D1 客户端（见 createD1ClientFromEnv）。');

  async function loadSectionFromD1(section) {
    assertSection(section);
    const [groupRows, stackRows, itemRows, hintRows] = await Promise.all([
      client.selectAll('SELECT * FROM groups WHERE section = ? ORDER BY sort_order, id', [section]),
      client.selectAll(
        'SELECT s.* FROM stacks s JOIN groups g ON g.id = s.group_id WHERE g.section = ? ORDER BY s.group_id, s.sort_order, s.id',
        [section]
      ),
      client.selectAll(
        'SELECT i.* FROM items i JOIN groups g ON g.id = i.group_id WHERE g.section = ? ORDER BY i.group_id, i.sort_order, i.id',
        [section]
      ),
      client.query('SELECT value FROM settings WHERE key = ?', [SECTIONS[section].hintKey]),
    ]);

    return assembleSection({
      groupRows,
      stackRows,
      itemRows,
      hint: hintRows.rows[0]?.value ?? '',
    });
  }

  return {
    mode: SOURCE_MODES.d1,
    describe: () => (typeof client.describe === 'function' ? client.describe() : 'Cloudflare D1'),
    loadSection: loadSectionFromD1,
    async writeDump(targetPath) {
      if (logger?.log) logger.log('· 正在从 D1 拉取全表以生成 data/content-dump.sql …');
      const db = await materializeD1Snapshot(client);
      try {
        return exportDump(db, targetPath);
      } finally {
        db.close();
      }
    },
    close() {
      // REST 客户端无连接需要关闭
    },
  };
}

/**
 * 按 CONTENT_SOURCE 创建数据源。
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] 环境变量（测试可注入）
 * @param {Function} [options.fetchImpl] 注入的 fetch（mock 测试用）
 * @param {object} [options.d1Client] 直接注入 D1 客户端（测试用，优先于 env）
 * @param {object} [options.logger]
 * @param {string} [options.dbPath] 本地模式使用的库路径（测试用）
 */
export function createContentSource({
  env = process.env,
  fetchImpl,
  d1Client = null,
  logger = console,
  dbPath = DB_PATH,
  timeoutMs,
} = {}) {
  const mode = resolveSourceMode(env);
  if (mode === SOURCE_MODES.local) {
    return createLocalContentSource({ dbPath });
  }

  const client = d1Client ?? createD1ClientFromEnv({ env, fetchImpl, timeoutMs });
  return createD1ContentSource({ client, logger });
}

export { D1ConfigError, DATA_DIR };
