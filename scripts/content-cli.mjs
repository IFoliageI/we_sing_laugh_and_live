#!/usr/bin/env node
// ============================================================
//  内容管理命令
//
//  用法（在项目根目录）：
//      pnpm content:stats                       两个栏目各分组的条目统计
//      pnpm content:groups                      列出所有分组（含分组 id，add 时要用）
//      pnpm content:list [--section voice|song] 列出所有条目（含条目 id）
//      pnpm content:add --group <分组> --zh <按钮文字> --path <音频路径> [更多选项]
//      pnpm content:rm-examples [--yes]         清除所有「示例」条目（默认只预览）
//      pnpm content:check                       核对：库里的文件在不在、目录里的文件有没有入库
//      pnpm content:dump [文件名]               导出为 .sql 文本（便于 diff / 备份）
//      pnpm content:sync                        重新生成 src/data/content.json
//
//  说明：这是「最小可用」版本。交互式向导、批量导入等留待后续完善。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import {
  openDb,
  groupStats,
  listAudioFiles,
  exportDump,
  SECTIONS,
  DB_PATH,
  ROOT,
  backupDatabase,
} from './lib/db.mjs';
import { addItem, exampleCleanupPlan, removeExamples, dumpTarget } from './lib/content-operations.mjs';
import { isRemoteMediaUrl } from '../src/lib/media-url.mjs';

// ---------- 参数解析：--key value / --flag ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const cmd = argv._[0] ?? 'help';
let db = null;

const pad = (s, n) => {
  // 中文按两个字符宽度估算，保证表格对齐
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

/** 按显示宽度截断（超长时末尾加 …） */
const clip = (s, n) => {
  let w = 0;
  let out = '';
  for (const ch of String(s)) {
    const cw = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (w + cw > n - 1) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
};

function sectionLabel(sec) {
  return SECTIONS[sec]?.label ?? sec;
}

// ------------------------------------------------------------
function cmdStats() {
  for (const sec of Object.keys(SECTIONS)) {
    const rows = groupStats(db, sec);
    console.log(`\n■ ${sectionLabel(sec)}`);
    if (rows.length === 0) {
      console.log('  （暂无分组）');
      continue;
    }
    console.log(
      '  ' + pad('分组', 34) + pad('id', 16) + pad('独立', 6) + pad('合集成员', 9) + pad('合集', 6) + pad('彩蛋', 6) + '示例'
    );
    let t = { s: 0, m: 0, k: 0, h: 0, e: 0 };
    for (const r of rows) {
      console.log(
        '  ' +
          pad((r.is_secret ? '★ ' : '') + r.title, 34) +
          pad(r.group_name, 16) +
          pad(r.singles, 6) +
          pad(r.stack_members, 9) +
          pad(r.stacks, 6) +
          pad(r.hiddens, 6) +
          r.examples
      );
      t.s += r.singles;
      t.m += r.stack_members;
      t.k += r.stacks;
      t.h += r.hiddens;
      t.e += r.examples;
    }
    console.log(
      '  ' + pad('合计', 34) + pad('', 16) + pad(t.s, 6) + pad(t.m, 9) + pad(t.k, 6) + pad(t.h, 6) + t.e
    );
  }
  console.log('\n（★ = 彩蛋分组，仅在「往日?」开关打开时显示）');
}

function cmdGroups() {
  const rows = db
    .prepare('SELECT id, section, group_name, title, sort_order, is_secret FROM groups ORDER BY section DESC, sort_order, id')
    .all();
  console.log('\n' + pad('栏目', 22) + pad('分组 id（add 用这个）', 20) + pad('标题', 34) + '彩蛋');
  for (const r of rows) {
    console.log(
      '  ' + pad(sectionLabel(r.section), 20) + pad(r.group_name, 20) + pad(r.title, 34) + (r.is_secret ? '★' : '')
    );
  }
}

function cmdList() {
  const sec = argv.section && SECTIONS[argv.section] ? argv.section : null;
  const where = sec ? 'WHERE g.section = ?' : '';
  const rows = db
    .prepare(
      `SELECT i.id, g.section, g.title AS group_title, i.kind, i.stack_id, i.path, i.zh, i.artist,
              i.info_time, i.info_title, i.is_example,
              (SELECT title FROM stacks s WHERE s.id = i.stack_id) AS stack_title
       FROM items i JOIN groups g ON g.id = i.group_id
       ${where}
       ORDER BY g.section DESC, g.sort_order, i.stack_id, i.sort_order, i.id`
    )
    .all(...(sec ? [sec] : []));

  console.log(`\n共 ${rows.length} 条${sec ? `（${sectionLabel(sec)}）` : ''}\n`);
  console.log('  ' + pad('id', 6) + pad('分组', 26) + pad('类型', 18) + pad('按钮文字', 32) + pad('音频路径', 36) + '示例');
  for (const r of rows) {
    const type = r.kind === 'hidden' ? '彩蛋' : r.stack_id ? `合集·${r.stack_title ?? ''}` : '独立';
    console.log(
      '  ' +
        pad(r.id, 6) +
        pad(clip(r.group_title, 24), 26) +
        pad(clip(type, 16), 18) +
        pad(clip(r.zh, 30), 32) +
        pad(clip(r.path, 34), 36) +
        (r.is_example ? '✔' : '')
    );
  }
}

async function cmdAdd() {
  const backupFile = await backupDatabase(db);
  const { id, group: g, stackId, kind, path: audioPath, zh } = addItem(db, argv);
  console.log(`✓ 已添加条目 id=${id}`);
  console.log(`    写入前备份：${backupFile}`);
  console.log(`    栏目：${sectionLabel(g.section)} / 分组：${g.title}`);
  console.log(`    类型：${kind === 'hidden' ? '彩蛋音频' : stackId ? `合集成员（${argv.stack}）` : '独立按钮'}`);
  console.log(`    文字：${zh}`);
  console.log(`    音频：${audioPath}`);

  const file = path.join(ROOT, 'public', 'audio', audioPath);
  if (!isRemoteMediaUrl(audioPath) && !fs.existsSync(file)) {
    console.log(`\n⚠ 注意：public/audio/${audioPath} 目前还不存在，记得把音频文件放进去。`);
  }
  console.log('\n下一步：pnpm content:sync    （或直接 pnpm build，会自动同步）');
}

async function cmdRmExamples() {
  const plan = exampleCleanupPlan(db);
  const items = plan.items.length;
  const stacks = plan.removable;

  if (items === 0 && stacks === 0) {
    console.log('· 没有标记为「示例」的条目，无需清理。');
    return;
  }

  if (argv.yes !== true) {
    console.log('\n将要删除（当前是预览，未实际执行）：');
    console.log(`  · 示例音频条目：${items} 条`);
    console.log(`  · 示例合集    ：${stacks} 个`);
    console.log(`  · 保留含真实内容的示例合集：${plan.retained} 个`);
    console.log('');
    for (const r of plan.items) console.log(`    [${r.g}] ${r.zh}  →  ${r.path}`);
    console.log('\n确认要删除请加 --yes ：');
    console.log('  pnpm content:rm-examples -- --yes');
    return;
  }

  const backupFile = await backupDatabase(db);
  const removed = removeExamples(db);
  console.log(`✓ 已清除示例音频条目 ${removed.items.length} 条、空示例合集 ${removed.removable} 个（分组与真实条目保留）`);
  console.log(`    删除前备份：${backupFile}`);
  console.log('\n下一步：pnpm content:sync');
}

function cmdCheck() {
  const rows = db.prepare('SELECT i.id, i.path, i.zh, g.title AS g FROM items i JOIN groups g ON g.id = i.group_id ORDER BY i.path').all();
  const files = listAudioFiles();
  const localRows = rows.filter((r) => !isRemoteMediaUrl(r.path));
  const inDb = new Set(localRows.map((r) => r.path));

  const missing = localRows.filter((r) => !fs.existsSync(path.join(ROOT, 'public', 'audio', r.path)));
  console.log(`远程音频：${rows.length - localRows.length} 条（不检查本地文件，也不请求远程地址）。`);
  const extra = files.filter((f) => !inDb.has(f));

  console.log(`\n库里条目 ${rows.length} 条 / 目录里音频文件 ${files.length} 个`);
  if (missing.length === 0) console.log('✓ 所有本地条目的音频文件都在');
  else {
    console.log(`\n✗ 库里有条目、但文件不存在（${missing.length} 条）：`);
    for (const r of missing) console.log(`    [${r.g}] ${r.zh}  →  public/audio/${r.path}`);
  }
  if (extra.length === 0) console.log('✓ 目录里没有未入库的音频');
  else {
    console.log(`\n⚠ 目录里有文件、但还没入库（${extra.length} 个）：`);
    for (const f of extra) console.log(`    public/audio/${f}`);
    console.log('  可用 pnpm content:add 逐个添加。');
  }
}

function cmdDump() {
  const file = dumpTarget(argv._[1]);
  exportDump(db, file);
  console.log(`✓ 已导出：${path.relative(ROOT, file)}`);
}

function cmdHelp() {
  console.log(`
内容管理命令（在项目根目录执行）

  pnpm content:stats                        两个栏目各分组的条目统计
  pnpm content:groups                       列出所有分组（add 时用 group_name）
  pnpm content:list [--section voice|song]  列出所有条目
  pnpm content:add --group <分组> --zh <文字> --path <音频路径> [选项]
  pnpm content:rm-examples [--yes]          清除所有「示例」条目（默认只预览）
  pnpm content:check                        核对库与 public/audio 目录是否一致
  pnpm content:dump [文件名]                导出为 .sql 文本
  pnpm content:sync                         重新生成 src/data/content.json

content:add 的全部选项：
  --section voice|song   栏目（默认 voice）
  --group  <分组>        分组 group_name 或标题（必填）
  --zh     <文字>        按钮上显示的文字（必填）
  --path   <路径/URL>    相对 public/audio 的路径或 HTTP(S) 音频直链（必填）
  --artist <作者>        原唱作者（歌单页按它分组）
  --stack  <合集名>      归入某个合集；合集不存在会自动创建
  --hidden               标记为彩蛋音频（仅在「往日?」开启后显示）
  --example              标记为示例条目（可被 rm-examples 清除）
  --time   <时间>        悬停卡片：时间
  --title  <标题>        悬停卡片：标题
  --note   <备注>        悬停卡片：备注
  --thumb  <图片>        缩略图：如 /thumbs/x.png 或 HTTP(S) 图床直链

内容源：${path.relative(ROOT, DB_PATH)}
`);
}

// ------------------------------------------------------------
const commands = {
  stats: cmdStats,
  groups: cmdGroups,
  list: cmdList,
  add: cmdAdd,
  'rm-examples': cmdRmExamples,
  check: cmdCheck,
  dump: cmdDump,
  help: cmdHelp,
};
try {
  if (!Object.hasOwn(commands, cmd)) throw new Error(`未知命令：${cmd}。请运行 pnpm content:help。`);
  if (cmd !== 'help') {
    const writes = cmd === 'add' || (cmd === 'rm-examples' && argv.yes === true);
    db = openDb({ readOnly: !writes });
  }
  await commands[cmd]();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  db?.close();
}
