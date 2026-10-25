// ============================================================
//  内容同步：内容源  →  src/data/content.json
//
//  用法：
//      node scripts/content-sync.mjs                       # 默认：本地 data/content.db
//      CONTENT_SOURCE=d1 node scripts/content-sync.mjs     # 构建期从 Cloudflare D1 REST 读取
//
//  - 每次 pnpm build / pnpm dev 都会自动先跑一遍，保证 JSON 与内容源一致。
//  - 默认（local）路径与改造前完全一致：content.json 逐字节不变、content-dump.sql 仍生成、日志不变。
//  - 内容没变化时不会改写文件（避免无意义的 git 改动与时间戳抖动）。
//  - 生成结果里不含时间戳，方便 git diff 审阅。
//  - 架构红线：D1 只在本构建脚本里通过 REST 读取，不引入任何运行时数据库/接口。
// ============================================================
import path from 'node:path';
import { CONTENT_JSON, DATA_DIR, SECTIONS, writeIfChanged } from './lib/db.mjs';
import { createContentSource } from './lib/content-source.mjs';

/** 生成物头部说明：local 模式下的两个字符串必须与改造前逐字节一致。 */
function generatedMetadata(source) {
  if (source.mode === 'local') {
    return {
      note: '本文件由 scripts/content-sync.mjs 自动生成，请勿手工编辑；内容源是 data/content.db',
      source: 'data/content.db',
    };
  }
  return {
    note: '本文件由 scripts/content-sync.mjs 自动生成，请勿手工编辑；内容源是 Cloudflare D1（构建期 REST 读取）',
    source: 'Cloudflare D1',
  };
}

async function syncContent(source) {
  const content = {
    _generated: generatedMetadata(source),
  };
  const summary = [];
  for (const section of Object.keys(SECTIONS)) {
    const data = await source.loadSection(section);
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
  if (await source.writeDump(path.join(DATA_DIR, 'content-dump.sql'))) {
    console.log('✓ 已更新 data/content-dump.sql（内容快照，便于 git diff）');
  }
}

async function main() {
  const source = createContentSource();
  try {
    // 默认 local 模式不打印额外日志，保证改造前的输出一字不差
    if (source.mode !== 'local') {
      console.log(`· 数据源：${source.describe()}`);
    }
    await syncContent(source);
  } finally {
    source.close();
  }
}

main().catch((error) => {
  // D1 相关失败给出人话原因而不是抛一堆栈（默认 local 路径行为不变）
  if (error?.name === 'D1ConfigError' || error?.name === 'D1ApiError') {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
