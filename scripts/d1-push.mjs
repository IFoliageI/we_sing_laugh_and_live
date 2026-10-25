#!/usr/bin/env node
// ============================================================
//  本地内容库 → Cloudflare D1
//
//  用法（在项目根目录执行）：
//      node scripts/d1-push.mjs                          # 默认 dry-run：只打印计划，不联网、不写库
//      node scripts/d1-push.mjs --yes                    # 真正写入 D1（幂等，可重复执行）
//      node scripts/d1-push.mjs --schema --yes           # 先按 data/schema.sql 建表，再推数据
//      node scripts/d1-push.mjs --yes --per-request 10   # 每个 HTTP 请求带几条语句（默认 20，上限 50）
//      node scripts/d1-push.mjs --yes --no-sequence      # 不碰 sqlite_sequence（见文末说明）
//      node scripts/d1-push.mjs --yes --allow-empty      # 本地内容表全空时仍允许推送（默认拒绝）
//
//  环境变量（三个都必需；只从环境变量读取，绝不写盘、绝不拼进 SQL、绝不打印）：
//      CLOUDFLARE_ACCOUNT_ID
//      CLOUDFLARE_D1_DATABASE_ID
//      CLOUDFLARE_API_TOKEN        # 写入需要 D1 Edit 权限
//    缺任何一个时，写入路径会由 createD1ClientFromEnv() 抛 D1ConfigError；
//    dry-run 不联网，因此只在输出里提示「未校验凭据」，不会因此失败。
//
//  写入策略（幂等：先清空再插入，随时可重跑）：
//    1. 可选 --schema：把 data/schema.sql 拆成单条语句逐条执行
//       （D1 的批量接口每条只接受一条语句；PRAGMA 与管理工具私有表会被剔除）；
//    2. 按外键顺序清空：items → stacks → groups → settings，再清掉 sqlite_sequence 相应行；
//    3. 按外键顺序分批插入：groups → stacks → items → settings，最后写回 sqlite_sequence。
//    同一个 HTTP 请求内语句顺序与上面一致，父表行永远先于子表行。
//
//  只推送公开内容表：groups / stacks / items / settings。
//  管理工具私有表 item_audio / audio_cleanup / audio_retired 只存在于本地，
//  绝不会进入推送清单（PRIVATE_TABLES 常量 + buildPushPlan 里的断言兜底）。
//
//  平台限制（来源：https://developers.cloudflare.com/d1/platform/limits/）：
//    · 单次查询最多 100 个绑定参数 → 每行参数数 = 列数，故每批行数 = floor(100 / 列数)；
//      NULL 用 SQL 字面量内联（D1 的 params 官方为 array of string，表达不了 NULL），
//      所以每批实际绑定参数只会更少；
//    · 单条 SQL ≤ 100 KB → 再按 90 KB 软上限二次切分（长路径 / 长备注时才会触发）；
//    · 单次查询 30 秒：内容库很小，单批只写几百行，远低于上限；
//    · 单行 / 单字符串 ≤ 2 MB：单行渲染后超限时直接报错，不会盲目发请求。
//
//  未在本任务中验证的部分（不要当成已知行为）：
//    · D1 是否允许写 sqlite_sequence（失败时本脚本只警告、不中断，可用 --no-sequence 跳过）；
//    · 一个 batch 请求内的语句是否整体事务化（官方文档只说明按顺序执行）。本脚本按「顺序执行」
//      设计：中途失败会留下「已清空但未写全」的 D1 库，修好原因后重跑即可恢复；
//    · schema.sql 全是 CREATE TABLE IF NOT EXISTS，不会给已存在的表补列，
//      远端旧结构缺列时需要先用 wrangler d1 迁移 ALTER TABLE。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH, SCHEMA_PATH, ROOT } from './lib/db.mjs';
import {
  D1_ENV,
  D1_LIMITS,
  createD1ClientFromEnv,
  scrubSecret,
  sqlPreview,
  toD1Params,
} from './lib/d1-client.mjs';

/** 允许推送到 D1 的公开内容表；数组顺序 = 外键父 → 子，也是 INSERT 顺序。 */
export const PUBLIC_TABLES = Object.freeze([
  { name: 'groups', orderBy: 'id', label: '分组' },
  { name: 'stacks', orderBy: 'id', label: '合集' },
  { name: 'items', orderBy: 'id', label: '音频条目' },
  { name: 'settings', orderBy: 'key', label: '全局配置' },
]);

/** 管理工具私有表：只存在于本地，绝不推送。留在这里作为断言与文档。 */
export const PRIVATE_TABLES = Object.freeze(['item_audio', 'audio_cleanup', 'audio_retired']);

/** DELETE 顺序：子表 → 父表（settings 无外键，按需求放在最后）。 */
export const DELETE_ORDER = Object.freeze(['items', 'stacks', 'groups', 'settings']);

/** 自增序列表：exportDump() 同步的也是这三个，保持两条快照路径一致。 */
const SEQUENCE_TABLES = Object.freeze(['groups', 'stacks', 'items']);

/** 单条 SQL 软上限：官方硬上限 100 KB，留 10% 余量给分隔符与估算误差。 */
const SQL_BYTE_BUDGET = Math.floor(D1_LIMITS.maxSqlBytes * 0.9);

/** 每个 HTTP 请求带几条语句（D1 客户端默认 20）；上限 50 为保守值，尚未压测。 */
const PER_REQUEST_DEFAULT = 20;
const PER_REQUEST_MAX = 50;

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ---------- 小工具 ----------
/** 按显示宽度补齐（中文按 2 个字符宽计），保证表格对齐。 */
function pad(text, width) {
  let w = 0;
  for (const ch of String(text)) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(text) + ' '.repeat(Math.max(0, width - w));
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 仓库内路径统一用 / 分隔，方便贴日志。 */
function repoPath(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

/** SQL 文本字面量（只用于内部常量：表名 / 序列名，绝不用于用户内容）。 */
function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 参数解析：--key value / --flag，与 scripts/content-cli.mjs 的风格一致。
 *  开关型参数不吞下一个 token（这样 `--schema --yes` 与 `--yes --schema` 都正常）。 */
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

/** 校验参数；返回 { help, yes, schema, skipSequence, allowEmpty, perRequest }。 */
export function parseOptions(argv) {
  const booleans = {
    yes: '--yes',
    schema: '--schema',
    'no-sequence': '--no-sequence',
    'allow-empty': '--allow-empty',
    'dry-run': '--dry-run',
  };
  const args = parseArgs(argv, new Set(['help', ...Object.keys(booleans)]));
  if (args.help === true) return { help: true };
  if (args._.length > 0) throw new Error(`d1-push 不接受位置参数：${args._.join(' ')}。用 --help 查看用法。`);

  const known = new Set(['help', 'per-request', ...Object.keys(booleans)]);
  for (const key of Object.keys(args)) {
    if (key !== '_' && !known.has(key)) throw new Error(`未知参数 --${key}。用 --help 查看用法。`);
  }
  for (const [key, label] of Object.entries(booleans)) {
    if (args[key] !== undefined && args[key] !== true) throw new Error(`${label} 是开关，不需要取值。`);
  }
  if (args.yes === true && args['dry-run'] === true) throw new Error('--yes 和 --dry-run 不能同时用。');

  let perRequest = PER_REQUEST_DEFAULT;
  if (args['per-request'] !== undefined) {
    const value = Number(args['per-request']);
    if (args['per-request'] === true || !Number.isSafeInteger(value) || value < 1 || value > PER_REQUEST_MAX) {
      throw new Error(`--per-request 需要 1–${PER_REQUEST_MAX} 的整数（默认 ${PER_REQUEST_DEFAULT}）。`);
    }
    perRequest = value;
  }

  return {
    help: false,
    yes: args.yes === true,
    schema: args.schema === true,
    skipSequence: args['no-sequence'] === true,
    allowEmpty: args['allow-empty'] === true,
    perRequest,
  };
}

// ---------- schema.sql 拆分 ----------
/**
 * 把 SQL 文本拆成单条语句（D1 批量接口每条只接受一条语句）。
 * 处理：行注释 --、块注释、单/双引号与反引号字符串（含 '' 转义）。
 * 不处理 [方括号标识符]（data/schema.sql 没有用到；将来用到需要补这里）。
 */
export function splitSqlStatements(sqlText) {
  const text = String(sqlText ?? '');
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        current += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += char;
  }

  if (quote) throw new Error('拆分 SQL 失败：字符串字面量没有闭合。');
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * 读出 --schema 要执行的语句。
 * 剔除：PRAGMA / 事务控制（D1 不需要、也不支持部分 PRAGMA），
 *       管理工具私有表（让 D1 保持只有公开内容表）。
 */
export function buildSchemaStatements(schemaPath = SCHEMA_PATH) {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`找不到建表文件：${repoPath(schemaPath)}（--schema 需要它）。`);
  }
  const statements = [];
  const skipped = [];
  for (const sql of splitSqlStatements(fs.readFileSync(schemaPath, 'utf8'))) {
    if (/^(PRAGMA|BEGIN|COMMIT|ROLLBACK|END)\b/i.test(sql)) {
      skipped.push({ sql, reason: 'D1 不需要 / 不支持该语句' });
      continue;
    }
    if (PRIVATE_TABLES.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(sql))) {
      skipped.push({ sql, reason: '管理工具私有表，不进入 D1' });
      continue;
    }
    statements.push({ sql, params: [] });
  }
  return { statements, skipped };
}

// ---------- 计划：把本地库读成「待执行语句」 ----------
function tableColumns(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  if (columns.length === 0) {
    throw new Error(`本地库缺少公开表 ${table}，请先恢复完整内容库（pnpm content:migrate）。`);
  }
  return columns;
}

/**
 * 一行 → (值列表 SQL, 绑定参数)。
 * NULL 必须内联成 SQL 字面量：D1 的 params 官方为 array of string，toD1Params() 会拒绝 NULL。
 */
function buildRowClause(row, columns) {
  const literals = [];
  const bound = [];
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) {
      literals.push('NULL');
      continue;
    }
    literals.push('?');
    bound.push(value);
  }
  // toD1Params：官方 params 为 array of string；提前转换还能让 dry-run 就发现不支持的字段类型
  return { clause: `(${literals.join(', ')})`, params: toD1Params(bound) };
}

/**
 * 把若干行渲染成多条 INSERT。
 * 切分规则：
 *   · 每批行数上限 = floor(100 / 列数)（D1 单次查询最多 100 个绑定参数）；
 *   · 同时守住单条 SQL 90 KB 软上限，超了就提前收尾；
 *   · 每批至少 1 行；单行本身就超限时直接报错。
 */
export function buildInsertStatements({ table, columns, rows }) {
  const rowCap = Math.max(1, Math.floor(D1_LIMITS.maxBoundParamsPerQuery / columns.length));
  const prefix = `INSERT INTO ${table} (${columns.join(', ')}) VALUES `;
  const prefixBytes = Buffer.byteLength(prefix);
  const statements = [];
  let buffer = { clauses: [], params: [], bytes: prefixBytes + 1 };

  const flush = () => {
    if (buffer.clauses.length === 0) return;
    statements.push({
      sql: prefix + buffer.clauses.join(', '),
      params: buffer.params,
      rowCount: buffer.clauses.length,
    });
    buffer = { clauses: [], params: [], bytes: prefixBytes + 1 };
  };

  for (const row of rows) {
    const { clause, params } = buildRowClause(row, columns);
    const clauseBytes = Buffer.byteLength(clause) + 2; // ', ' 分隔符
    if (prefixBytes + clauseBytes > SQL_BYTE_BUDGET) {
      throw new Error(
        `${table} 有单行数据渲染后约 ${prefixBytes + clauseBytes} 字节，超过单条 SQL 软上限 ${SQL_BYTE_BUDGET} 字节，无法推送。`
      );
    }
    const wouldOverflow =
      buffer.clauses.length >= rowCap ||
      buffer.params.length + params.length > D1_LIMITS.maxBoundParamsPerQuery ||
      buffer.bytes + clauseBytes > SQL_BYTE_BUDGET;
    if (buffer.clauses.length > 0 && wouldOverflow) flush();
    buffer.clauses.push(clause);
    buffer.params.push(...params);
    buffer.bytes += clauseBytes;
  }
  flush();

  return {
    rowCap,
    statements,
    bytes: statements.reduce((sum, statement) => sum + Buffer.byteLength(statement.sql), 0),
  };
}

/** 本地库里的自增序列（sqlite_sequence 不存在时返回空）。 */
function readSequences(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
  if (!exists) return [];
  return db
    .prepare(
      `SELECT name, seq FROM sqlite_sequence WHERE name IN (${SEQUENCE_TABLES.map(() => '?').join(', ')}) ORDER BY name`
    )
    .all(...SEQUENCE_TABLES);
}

/** 读本地库，产出完整的推送计划（纯数据，不发任何请求，dry-run 与 --yes 共用）。 */
export function buildPushPlan(db, { perRequest = PER_REQUEST_DEFAULT } = {}) {
  for (const def of PUBLIC_TABLES) {
    if (PRIVATE_TABLES.includes(def.name)) {
      throw new Error(`内部错误：私有表 ${def.name} 不能出现在推送清单里。`);
    }
  }

  const tables = [];
  for (const def of PUBLIC_TABLES) {
    const columns = tableColumns(db, def.name);
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${def.name} ORDER BY ${def.orderBy}`).all();
    const { rowCap, statements, bytes } = buildInsertStatements({ table: def.name, columns, rows });
    tables.push({
      name: def.name,
      label: def.label,
      columns,
      rows: rows.length,
      rowCap,
      statements,
      bytes,
      requests: Math.ceil(statements.length / perRequest),
    });
  }

  const sequenceRows = readSequences(db).map(({ name, seq }) => {
    const value = Number(seq);
    if (!Number.isSafeInteger(value)) throw new Error(`sqlite_sequence 里 ${name} 的 seq 不是整数：${String(seq)}`);
    return { name, seq: value };
  });

  const sequenceInserts = sequenceRows.map(({ name, seq }) => ({
    // seq 内联成数字：sqlite_sequence 的列没有声明类型（无亲和性），绑定字符串会被当文本存
    sql: `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ${seq})`,
    params: toD1Params([name]),
  }));

  const totals = tables.reduce(
    (sum, table) => ({
      rows: sum.rows + table.rows,
      statements: sum.statements + table.statements.length,
      bytes: sum.bytes + table.bytes,
      requests: sum.requests + table.requests,
    }),
    { rows: 0, statements: 0, bytes: 0, requests: 0 }
  );

  return {
    perRequest,
    tables,
    totals,
    sequenceRows,
    sequenceInserts,
    deleteStatements: DELETE_ORDER.map((name) => ({ sql: `DELETE FROM ${name}`, params: [] })),
    sequenceDelete: {
      sql: `DELETE FROM sqlite_sequence WHERE name IN (${SEQUENCE_TABLES.map(quoteSqlString).join(', ')})`,
      params: [],
    },
  };
}

// ---------- 输出 ----------
function printPlan({ plan, schemaPlan }) {
  console.log(`· 数据源：${repoPath(DB_PATH)}（只读）`);
  console.log('\n将要执行：');

  if (schemaPlan) {
    console.log(`  [1/4] 建表：${repoPath(SCHEMA_PATH)} 拆出 ${schemaPlan.statements.length} 条语句`);
    for (const skipped of schemaPlan.skipped) {
      console.log(`        跳过（${skipped.reason}）：${sqlPreview(skipped.sql, 70)}`);
    }
    console.log('        注意：schema.sql 全是 CREATE TABLE IF NOT EXISTS，不会给已存在的表补列。');
  } else {
    console.log('  [1/4] 建表：跳过（未指定 --schema，假定 D1 上已有表）');
  }

  console.log('  [2/4] 清空公开内容表（按外键顺序）：');
  for (const statement of plan.deleteStatements) console.log(`        ${statement.sql};`);
  console.log(`        ${plan.sequenceDelete.sql};`);

  console.log('  [3/4] 分批插入（父表 → 子表）：');
  console.log(
    '        ' +
      pad('表', 12) +
      pad('行数', 8) +
      pad('列数', 8) +
      pad('每批行数', 12) +
      pad('语句数', 10) +
      pad('批次数', 10) +
      '预估 SQL'
  );
  for (const table of plan.tables) {
    console.log(
      '        ' +
        pad(table.name, 12) +
        pad(table.rows, 8) +
        pad(table.columns.length, 8) +
        pad(table.rowCap, 12) +
        pad(table.statements.length, 10) +
        pad(table.requests, 10) +
        formatBytes(table.bytes)
    );
  }
  console.log(
    '        ' +
      pad('合计', 12) +
      pad(plan.totals.rows, 8) +
      pad('—', 8) +
      pad('—', 12) +
      pad(plan.totals.statements, 10) +
      pad(plan.totals.requests, 10) +
      formatBytes(plan.totals.bytes)
  );

  console.log(
    `  [4/4] 写回 sqlite_sequence：${plan.sequenceRows.length} 行` +
      (plan.sequenceRows.length > 0
        ? `（插入内容时 SQLite 会自动补行，所以写回前再清一次；${plan.sequenceRows
            .map((row) => `${row.name}=${row.seq}`)
            .join(' / ')}）`
        : '')
  );

  console.log('说明：');
  console.log('  · 只推送 groups / stacks / items / settings 四张公开内容表。');
  console.log(`  · 管理工具私有表 ${PRIVATE_TABLES.join(' / ')} 只存在于本地，不会推送。`);
  console.log(
    `  · 每批行数 = floor(${D1_LIMITS.maxBoundParamsPerQuery} / 列数)；NULL 内联后实际绑定参数更少。`
  );
  console.log(`  · 批次数 = ceil(语句数 / ${plan.perRequest})：一个批次 = 一个 HTTP 请求里的多条语句。`);
  console.log(`  · 单条 SQL 上限 ${D1_LIMITS.maxSqlBytes} 字节，超过 ${SQL_BYTE_BUDGET} 字节会自动再切一批。`);
}

function printDryRunFooter({ options }) {
  console.log('\n以上是 dry-run 输出：没有联网、没有写 D1。');
  console.log(
    `确认要写入请加 --yes：node scripts/d1-push.mjs --yes${options.schema ? ' --schema' : ''}` +
      `${options.skipSequence ? ' --no-sequence' : ''}`
  );
}

// ---------- 执行 ----------
/** 逐批发送语句；失败时指出是哪一批，并用 sqlPreview / scrubSecret 收尾。 */
async function runStatements(client, statements, { label, perRequest, scrub }) {
  let changes = 0;
  for (let start = 0; start < statements.length; start += perRequest) {
    const chunk = statements.slice(start, start + perRequest);
    try {
      const results = await client.batch(chunk, { perRequest });
      for (const result of results) changes += Number(result?.meta?.changes) || 0;
    } catch (error) {
      const preview = sqlPreview(chunk[0]?.sql ?? '');
      const where =
        chunk.length === 1
          ? `SQL 预览：${preview}`
          : `本批 ${chunk.length} 条语句，首条 SQL 预览：${preview}`;
      throw new Error(
        `${label} 失败：第 ${start + 1}–${start + chunk.length} 条语句（共 ${statements.length} 条）出错；${where}\n` +
          `原因：${scrub(error?.message ?? String(error))}`,
        { cause: error }
      );
    }
  }
  return changes;
}

/** dry-run 时想顺带显示目标库（不联网）：缺凭据就只提示缺少哪些变量。 */
function describeTarget() {
  const missing = [D1_ENV.accountId, D1_ENV.databaseId, D1_ENV.token].filter(
    (name) => !String(process.env[name] ?? '').trim()
  );
  if (missing.length > 0) return { client: null, text: `未校验凭据（缺少 ${missing.join('、')}；dry-run 不联网）` };
  const client = createD1ClientFromEnv();
  return { client, text: client.describe() };
}

async function pushPlan(client, plan, options, scrub, schemaPlan) {
  let sequenceWritable = !options.skipSequence;

  if (schemaPlan) {
    console.log(`\n[1/4] 按 ${repoPath(SCHEMA_PATH)} 建表：${schemaPlan.statements.length} 条语句`);
    await runStatements(client, schemaPlan.statements, { label: '执行建表语句', perRequest: plan.perRequest, scrub });
    console.log(`✓ 建表语句已执行（跳过 ${schemaPlan.skipped.length} 条）`);
  } else {
    console.log('\n[1/4] 建表：跳过（未指定 --schema）');
  }

  console.log(`\n[2/4] 清空公开内容表：${plan.deleteStatements.length} 条 DELETE`);
  const deleted = await runStatements(client, plan.deleteStatements, {
    label: '清空公开内容表',
    perRequest: plan.perRequest,
    scrub,
  });
  console.log(`✓ 已清空（D1 回报 changes=${deleted}）`);

  if (options.skipSequence) {
    console.log('   sqlite_sequence：已跳过（--no-sequence）');
  } else {
    try {
      await runStatements(client, [plan.sequenceDelete], {
        label: '清空 sqlite_sequence',
        perRequest: plan.perRequest,
        scrub,
      });
      console.log('   sqlite_sequence：已清空');
    } catch (error) {
      sequenceWritable = false;
      console.warn(`   ⚠ 清空 sqlite_sequence 失败（不影响内容数据）：${scrub(error.message)}`);
      console.warn('     后续会跳过写回序列；可用 --no-sequence 明确跳过这一步。');
    }
  }

  console.log('\n[3/4] 分批插入：');
  let insertedRows = 0;
  let insertedChanges = 0;
  for (const table of plan.tables) {
    if (table.statements.length === 0) {
      console.log(`   ${pad(table.name, 9)} 0 行 → 跳过`);
      continue;
    }
    const changes = await runStatements(client, table.statements, {
      label: `写入 ${table.name}`,
      perRequest: plan.perRequest,
      scrub,
    });
    insertedRows += table.rows;
    insertedChanges += changes;
    console.log(
      `   ✓ ${pad(table.name, 9)} ${pad(table.rows, 5)} 行 → ${table.statements.length} 条语句 / ` +
        `${Math.ceil(table.statements.length / plan.perRequest)} 个批次（D1 回报 changes=${changes}）`
    );
  }

  if (sequenceWritable && plan.sequenceInserts.length > 0) {
    try {
      // 插入内容行时 SQLite 会按最大 id 自动重建 sqlite_sequence 行，
      // 所以写回前必须再清一次，否则会留下同名重复行（exportDump 也是「先删后插」的顺序）。
      await runStatements(client, [plan.sequenceDelete, ...plan.sequenceInserts], {
        label: '写回 sqlite_sequence',
        perRequest: plan.perRequest,
        scrub,
      });
      console.log(`✓ 已写回 sqlite_sequence ${plan.sequenceInserts.length} 行`);
    } catch (error) {
      console.warn(`   ⚠ 写回 sqlite_sequence 失败（不影响内容数据，只影响后续自增 id 起点）：${scrub(error.message)}`);
    }
  } else if (options.skipSequence) {
    console.log('   sqlite_sequence：已跳过（--no-sequence）');
  }

  console.log(
    `\n✓ 推送完成：${insertedRows} 行 / ${plan.totals.statements} 条 INSERT 语句（D1 回报 changes=${insertedChanges}）`
  );
  console.log('下一步：CONTENT_SOURCE=d1 pnpm build（构建期从 D1 读数据）。');
}

function printHelp() {
  console.log(`
本地内容库 → Cloudflare D1（默认 dry-run）

  node scripts/d1-push.mjs [选项]

选项：
  --yes               真正写入 D1（不加时只打印计划，不联网）
  --schema            写入前先执行 data/schema.sql 建表（拆成单条语句执行）
  --per-request <n>   每个 HTTP 请求带几条语句（1–${PER_REQUEST_MAX}，默认 ${PER_REQUEST_DEFAULT}）
  --no-sequence       不读不写 sqlite_sequence（D1 拒绝写该表时的退路）
  --allow-empty       本地内容表全空时仍允许推送（默认拒绝，避免把 D1 清空）
  --dry-run           显式 dry-run（与不加 --yes 等价）
  --help              显示本帮助

环境变量（三个都必需）：
  ${D1_ENV.accountId}
  ${D1_ENV.databaseId}
  ${D1_ENV.token}        # 写入需要 D1 Edit 权限

推送顺序：groups → stacks → items → settings；清空顺序反之（items 先删）。
只推送公开内容表；${PRIVATE_TABLES.join(' / ')} 绝不推送。
内容源：${repoPath(DB_PATH)}
`);
}

// ---------- 入口 ----------
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // 先拆 schema：dry-run 也能验证拆分结果，且不合法时立刻失败（不联网）
  const schemaPlan = options.schema ? buildSchemaStatements() : null;

  let client = null;
  if (options.yes) {
    // 缺环境变量时由 createD1ClientFromEnv() 抛 D1ConfigError（带「去配哪个变量」的提示）
    client = createD1ClientFromEnv();
    console.log(`· 目标：${client.describe()}`);
    console.log('· 模式：写入（--yes，会先清空再插入）');
  } else {
    const described = describeTarget();
    client = described.client;
    console.log(`· 目标：${described.text}`);
    console.log('· 模式：dry-run（不联网、不写 D1）');
  }

  const db = openDb({ readOnly: true });
  let plan;
  try {
    plan = buildPushPlan(db, { perRequest: options.perRequest });
  } finally {
    db.close();
  }

  printPlan({ plan, schemaPlan });

  const isEmpty = plan.totals.rows === 0;
  if (isEmpty) console.log('\n⚠ 本地内容表全部为空：加 --yes 运行会被拒绝（除非同时加 --allow-empty）。');

  if (!options.yes) {
    printDryRunFooter({ options });
    return;
  }
  if (isEmpty && !options.allowEmpty) {
    throw new Error('本地内容表全部为空，拒绝把 D1 清空。确认要这么做请加 --allow-empty（通常说明本地库没恢复好）。');
  }

  const scrub = (text) => scrubSecret(text, String(process.env[D1_ENV.token] ?? ''));
  await pushPlan(client, plan, options, scrub, schemaPlan);
}

if (isMain) {
  main().catch((error) => {
    const scrub = (text) => scrubSecret(text, String(process.env[D1_ENV.token] ?? ''));
    console.error(`✗ ${scrub(error?.message ?? String(error))}`);
    if (error?.name === 'D1ConfigError') {
      console.error('（凭据只从环境变量读取；不要把 token 写进仓库或 .env 提交。）');
    }
    process.exitCode = 1;
  });
}
