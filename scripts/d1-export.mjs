#!/usr/bin/env node
// ============================================================
//  Cloudflare D1 → 本地 .sql 快照
//
//  用法（在项目根目录执行）：
//      node scripts/d1-export.mjs                        # 默认 dry-run：只读拉取并报告行数，不落盘
//      node scripts/d1-export.mjs --write                # 写入 data/d1-export.sql
//      node scripts/d1-export.mjs --write 备份/d1.sql     # 自定义文件名（相对 data/，必须是 .sql）
//      node scripts/d1-export.mjs --write --page-size 50 # 每页行数（默认 100）
//
//  环境变量（三个都必需；只从环境变量读取，绝不写盘、绝不拼进 SQL、绝不打印）：
//      CLOUDFLARE_ACCOUNT_ID
//      CLOUDFLARE_D1_DATABASE_ID
//      CLOUDFLARE_API_TOKEN        # 只读拉取，D1 Read 权限即可
//
//  · 快照格式与 scripts/lib/db.mjs 的 exportDump() 一致：同一段文件头、同一个 DELETE 前导、
//    同样的 INSERT 语句形态，因此可以直接重建：
//        sqlite3 data/content.db < data/d1-export.sql
//  · 内容是确定性的（不含时间戳），配合 writeIfChanged()：数据没变就完全不改动文件。
//  · 分页读取：D1 REST 没有游标，用 ORDER BY <key> LIMIT n OFFSET m 逐页读；
//    ⚠ 两次查询之间若有人写库，OFFSET 分页可能漏行 / 重复（构建期只读场景可接受）；
//    ⚠ D1 REST 单次返回的行数上限官方文档没有写明（本任务无法核实），
//      因此页大小默认保守取 100；数据多时不要盲目调大 --page-size。
//  · NULL 直接写 SQL NULL 字面量；字符串按 '' 转义；数字（D1 的 JSON 保留类型）按数字字面量输出。
//  · 只导出公开内容表 groups / stacks / items / settings。
//    管理工具私有表（item_audio / audio_cleanup / audio_retired）如果出现在 D1 上会被忽略并提示：
//    它们只应存在于本地，绝不随 D1 往返。
//  · sqlite_sequence 尽力而为：D1 若拒绝读取该表，则跳过序列行并提示，其余内容照常导出
//    （D1 是否允许读 sqlite_sequence 未在本任务核实）。
//
//  ⚠ 重放到已有 data/content.db 会先清空 groups/stacks/items/settings；
//    items 的 ON DELETE CASCADE 还会连带清掉 item_audio 私有目录（D1 快照里没有这些数据）。
//    所以重放前请先备份本地库（pnpm content:dump 或复制 data/content.db）。
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged, ROOT } from './lib/db.mjs';
import { dumpTarget } from './lib/content-operations.mjs';
import { D1_ENV, createD1ClientFromEnv, scrubSecret } from './lib/d1-client.mjs';

/** 默认落盘文件名（相对 data/，由 dumpTarget() 校验）。 */
export const DEFAULT_FILE_NAME = 'd1-export.sql';

/**
 * 导出的公开内容表。
 * columns 是「基准列」，必须全部出现在远端（缺了说明远端结构不对，直接报错）；
 * extraColumns 是旧库可能缺少的可选列（与 exportDump() 的处理一致：有就导，没有就不导）。
 * 顺序即 INSERT 顺序：groups → stacks → items → settings（父表在前，满足外键）。
 */
export const EXPORT_TABLES = Object.freeze([
  {
    name: 'groups',
    key: 'id',
    label: '分组',
    columns: ['id', 'section', 'group_name', 'title', 'sort_order', 'is_secret'],
  },
  {
    name: 'stacks',
    key: 'id',
    label: '合集',
    columns: ['id', 'group_id', 'title', 'sort_order', 'is_example'],
  },
  {
    name: 'items',
    key: 'id',
    label: '音频条目',
    columns: [
      'id',
      'group_id',
      'stack_id',
      'kind',
      'path',
      'zh',
      'artist',
      'info_time',
      'info_title',
      'info_note',
      'info_thumb',
      'sort_order',
      'is_example',
      'created_at',
    ],
    extraColumns: ['info_duration', 'info_uploader', 'info_songcut_text', 'special_effect'],
  },
  {
    name: 'settings',
    key: 'key',
    label: '全局配置',
    columns: ['key', 'value'],
  },
]);

/** 管理工具私有表：只应存在于本地；如果出现在 D1 上，导出时忽略并提示。 */
export const PRIVATE_TABLES = Object.freeze(['item_audio', 'audio_cleanup', 'audio_retired']);

/** 自增序列表：与 exportDump() 同步的保持一致。 */
const SEQUENCE_TABLES = Object.freeze(['groups', 'stacks', 'items']);

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 1000;

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ---------- 小工具 ----------
function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 仓库内路径统一用 / 分隔，方便贴日志。 */
function repoPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

/** 错误信息兜底擦除 token（客户端内部已擦过一次，这里是双保险）。 */
function scrubText(text) {
  return scrubSecret(text, String(process.env[D1_ENV.token] ?? ''));
}

/** 参数解析：--key value / --flag，与 scripts/content-cli.mjs 的风格一致。
 *  开关型参数（write / dry-run / help）不吞下一个 token，这样 `--write 备份.sql` 才能正常工作。 */
function parseArgs(argv, booleanFlags) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

/** 校验参数；返回 { help, write, pageSize, fileName }。 */
export function parseOptions(argv) {
  const booleans = { write: '--write', 'dry-run': '--dry-run' };
  const args = parseArgs(argv, new Set(['help', ...Object.keys(booleans)]));
  if (args.help === true) return { help: true };

  const known = new Set(['help', 'page-size', ...Object.keys(booleans)]);
  for (const key of Object.keys(args)) {
    if (key !== '_' && !known.has(key)) throw new Error(`未知参数 --${key}。用 --help 查看用法。`);
  }
  for (const [key, label] of Object.entries(booleans)) {
    if (args[key] !== undefined && args[key] !== true) throw new Error(`${label} 是开关，不需要取值。`);
  }
  if (args._.length > 1) throw new Error(`最多只能给一个快照文件名，收到：${args._.join(' ')}`);
  if (args.write === true && args['dry-run'] === true) throw new Error('--write 和 --dry-run 不能同时用。');

  let pageSize = PAGE_SIZE_DEFAULT;
  if (args['page-size'] !== undefined) {
    const value = Number(args['page-size']);
    if (args['page-size'] === true || !Number.isSafeInteger(value) || value < 1 || value > PAGE_SIZE_MAX) {
      throw new Error(`--page-size 需要 1–${PAGE_SIZE_MAX} 的整数（默认 ${PAGE_SIZE_DEFAULT}）。`);
    }
    pageSize = value;
  }

  const fileName = args._[0] === undefined ? DEFAULT_FILE_NAME : String(args._[0]);
  return { help: false, write: args.write === true, pageSize, fileName };
}

// ---------- 快照渲染（与 exportDump 的语句形态保持一致） ----------
/**
 * SQL 字面量。
 * 与 exportDump() 的差别：D1 的 JSON 保留了列类型，所以数字按数字字面量输出（而不是一律加引号）；
 * 字符串 / 时间文本照旧用 '' 转义。语义与 exportDump 生成的快照一致。
 */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`无法写入快照：出现非有限数字 ${String(value)}。`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(
    `无法写入快照：遇到不支持的字段类型 ${typeof value}（${Object.prototype.toString.call(value)}），已中止以免写出坏数据。`
  );
}

/**
 * 依据实际返回的行推断要写进 INSERT 的列：
 * 先按基准列 + 可选列的顺序取「远端确实存在」的列，再补上远端多出来的列（排序，保证输出稳定）。
 * 基准列缺失说明远端结构不对（例如不是内容库），直接报错而不是写出残缺快照。
 */
export function deriveColumns(def, rows) {
  if (rows.length === 0) return [];
  const present = new Set(Object.keys(rows[0]));
  const missing = def.columns.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new Error(
      `D1 的 ${def.name} 表缺少列：${missing.join('、')}。` +
        '如果远端还没建表，请先运行 node scripts/d1-push.mjs --schema --yes 建表并推送数据。'
    );
  }
  const preferred = [...def.columns, ...(def.extraColumns ?? [])];
  const extraUnknown = [...present].filter((column) => !preferred.includes(column)).sort();
  return [...preferred.filter((column) => present.has(column)), ...extraUnknown];
}

/** 把表格数据渲染成 .sql 文本（纯函数，便于离线验证）。 */
export function renderSnapshot({ tables, sequences = [] }) {
  const lines = [
    '-- ============================================================',
    '--  内容快照（由 scripts/d1-export.mjs 从 Cloudflare D1 导出，请勿手工编辑）',
    '--  格式与 data/content-dump.sql 一致（DELETE 前导 + INSERT 语句）。',
    '--  重建：sqlite3 data/content.db < data/d1-export.sql',
    '-- ============================================================',
    'PRAGMA foreign_keys = ON;',
    'BEGIN;',
    'DELETE FROM items; DELETE FROM stacks; DELETE FROM groups; DELETE FROM settings;',
  ];

  for (const table of tables) {
    if (table.rows.length === 0 || table.columns.length === 0) continue;
    for (const row of table.rows) {
      lines.push(
        `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${table.columns
          .map((column) => sqlLiteral(row[column]))
          .join(', ')});`
      );
    }
  }

  // 保留已删除内容的最高 id，避免恢复后复用旧 id（与 exportDump 一致）。
  lines.push(`DELETE FROM sqlite_sequence WHERE name IN (${SEQUENCE_TABLES.map((name) => `'${name}'`).join(', ')});`);
  for (const sequence of sequences) {
    lines.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${sqlLiteral(sequence.name)}, ${sqlLiteral(sequence.seq)});`);
  }
  lines.push('COMMIT;', '');

  return lines.join('\n');
}

// ---------- 拉取 ----------
async function fetchTable(client, def, { pageSize }) {
  try {
    const rows = await client.selectAll(`SELECT * FROM ${def.name} ORDER BY ${def.key}`, [], { pageSize });
    return { name: def.name, label: def.label, columns: deriveColumns(def, rows), rows };
  } catch (error) {
    throw new Error(
      `拉取 ${def.name} 失败（ORDER BY ${def.key}，每页 ${pageSize} 行）：\n${scrubText(error?.message ?? String(error))}`,
      { cause: error }
    );
  }
}

/** 尽力而为：读 sqlite_sequence（D1 是否允许读未核实，失败就跳过）。 */
async function fetchSequences(client, { pageSize, logger = console }) {
  try {
    return await client.selectAll(
      `SELECT name, seq FROM sqlite_sequence WHERE name IN (${SEQUENCE_TABLES.map((name) => `'${name}'`).join(', ')}) ORDER BY name`,
      [],
      { pageSize }
    );
  } catch (error) {
    logger.warn(`   sqlite_sequence：拉取失败，已跳过序列行（${scrubText(error?.message ?? String(error))}）`);
    return [];
  }
}

/** 尽力而为：提示 D1 上是否存在只该存在于本地的私有表。 */
async function reportPrivateTables(client, { logger = console } = {}) {
  try {
    const rows = await client.selectAll(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
      { pageSize: PAGE_SIZE_DEFAULT }
    );
    const privates = rows.map((row) => String(row.name)).filter((name) => PRIVATE_TABLES.includes(name));
    if (privates.length > 0) {
      logger.warn(`\n⚠ D1 上存在管理工具私有表 ${privates.join(' / ')}：本快照不会导出它们（它们只应存在于本地）。`);
    }
  } catch {
    // 该查询在 D1 上是否可用未核实：失败就算了，不影响导出
  }
}

/**
 * 拉取全部公开内容表并渲染快照（main 与离线测试共用）。
 * @param {object} client D1 客户端（需实现 selectAll，可注入 mock）
 * @returns {Promise<{ tables: Array<object>, sequences: Array<object>, sql: string, insertCount: number, bytes: number }>}
 */
export async function buildSnapshot(client, { pageSize = PAGE_SIZE_DEFAULT, logger = console } = {}) {
  const tables = [];
  for (const def of EXPORT_TABLES) {
    const table = await fetchTable(client, def, { pageSize });
    tables.push(table);
    const pages = table.rows.length > 0 ? `（${Math.ceil(table.rows.length / pageSize)} 页）` : '';
    logger.log(`   ${def.name.padEnd(15)}${String(table.rows.length).padStart(5)} 行${pages}`);
  }

  const sequences = await fetchSequences(client, { pageSize, logger });
  logger.log(`   ${'sqlite_sequence'.padEnd(15)}${String(sequences.length).padStart(5)} 行`);

  await reportPrivateTables(client, { logger });

  const sql = renderSnapshot({ tables, sequences });
  return {
    tables,
    sequences,
    sql,
    insertCount: tables.reduce((sum, table) => sum + table.rows.length, 0),
    bytes: Buffer.byteLength(sql, 'utf8'),
  };
}

// ---------- 输出 ----------
function printReplayWarning() {
  console.log('\n⚠ 重放到已有本地库前请先备份（pnpm content:dump 或复制 data/content.db）：');
  console.log('  快照会先清空 groups/stacks/items/settings，items 的 ON DELETE CASCADE');
  console.log('  还会连带清掉 item_audio 私有目录（D1 快照里没有这些数据）。');
}

function printHelp() {
  console.log(`
Cloudflare D1 → 本地 .sql 快照（默认 dry-run）

  node scripts/d1-export.mjs [选项] [文件名]

选项：
  --write             真正落盘（不加时只拉取并报告行数）
  --page-size <n>     每页行数（1–${PAGE_SIZE_MAX}，默认 ${PAGE_SIZE_DEFAULT}）
  --dry-run           显式 dry-run（与不加 --write 等价）
  --help              显示本帮助

位置参数：
  文件名              相对 data/ 的 .sql 路径，默认 ${DEFAULT_FILE_NAME}
                      （由 scripts/lib/content-operations.mjs 的 dumpTarget() 校验，
                        不允许绝对路径、不允许覆盖 data/schema.sql）

环境变量（三个都必需）：
  ${D1_ENV.accountId}
  ${D1_ENV.databaseId}
  ${D1_ENV.token}        # 只读拉取，D1 Read 权限即可

导出范围：groups / stacks / items / settings（公开内容表）+ sqlite_sequence。
私有表 ${PRIVATE_TABLES.join(' / ')} 不导出。
`);
}

// ---------- 入口 ----------
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // 先校验落盘目标（不联网）：文件名不合法时立刻失败，避免拉完数据才发现写不了
  const target = dumpTarget(options.fileName);
  const relativeTarget = repoPath(target);

  const client = createD1ClientFromEnv();
  console.log(`· 目标：${client.describe()}`);
  console.log(`· 模式：${options.write ? '写入（--write）' : 'dry-run（只读拉取，不落盘）'}`);
  console.log(`· 分页：ORDER BY <key> LIMIT ${options.pageSize} OFFSET n`);
  console.log('');

  const snapshot = await buildSnapshot(client, { pageSize: options.pageSize });

  console.log(`\n· 快照：${snapshot.insertCount} 条 INSERT / ${formatBytes(snapshot.bytes)}`);
  console.log(`· 目标文件：${relativeTarget}`);
  printReplayWarning();

  if (!options.write) {
    console.log('\n以上是 dry-run：没有落盘。确认要写入请加 --write：');
    console.log(
      `  node scripts/d1-export.mjs --write${options.fileName === DEFAULT_FILE_NAME ? '' : ` ${options.fileName}`}`
    );
    return;
  }

  if (writeIfChanged(target, snapshot.sql)) console.log(`\n✓ 已写入 ${relativeTarget}`);
  else console.log(`\n· 内容无变化（${relativeTarget} 已是最新）`);
}

if (isMain) {
  main().catch((error) => {
    console.error(`✗ ${scrubText(error?.message ?? String(error))}`);
    if (error?.name === 'D1ConfigError') {
      console.error('（凭据只从环境变量读取；不要把 token 写进仓库或 .env 提交。）');
    }
    process.exitCode = 1;
  });
}
