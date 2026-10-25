// ============================================================
//  content-source.mjs 单元测试
//  · local 模式用临时 SQLite 库（与 tests/content.test.mjs 同一套 fixture 思路）；
//  · d1 模式用 mock fetch，把请求交给同一个本地库执行（绝不发真实网络请求）；
//  · 两种模式必须产出与 db.mjs loadSection() 完全同形、键顺序稳定的对象，
//    否则 src/data/content.json 会出现无意义的逐字节差异。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, loadSection } from '../scripts/lib/db.mjs';
import { D1ApiError, D1ConfigError, D1_ENV } from '../scripts/lib/d1-client.mjs';
import {
  CONTENT_SOURCE_ENV,
  SOURCE_MODES,
  assembleSection,
  createContentSource,
  createLocalContentSource,
  resolveSourceMode,
  toVoiceRow,
} from '../scripts/lib/content-source.mjs';

const D1_TOKEN = 'd1-test-token-should-not-leak';
const D1_BASE = 'https://d1.example.test/client/v4';
const D1_QUERY_URL = `${D1_BASE}/accounts/acct-test/d1/database/db-test/query`;

// ---------- fixture：临时内容库 ----------

/**
 * 建一个临时内容库，覆盖普通分组 / 保密分组 / 合集 / 彩蛋 / 卡片元数据 / 空提示。
 * 数据量远小于一页（pageSize=100），保证 selectAll 一次就能读完。
 */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesing-source-test-'));
  const dbPath = path.join(dir, 'content.db');
  const db = openDb({ create: true, dbPath });
  db.exec(`
    INSERT INTO groups (id, section, group_name, title, sort_order, is_secret) VALUES
      (1, 'voice', 'noise', 'Noise', 0, 0),
      (2, 'voice', 'echo', 'Echo', 1, 0),
      (3, 'voice', 'forgotten', 'Forgotten', 2, 1),
      (4, 'song', 'covers', 'Covers', 0, 0);

    INSERT INTO stacks (id, group_id, title, sort_order) VALUES
      (1, 1, 'Stack A', 0),
      (2, 1, NULL, 1),
      (3, 4, 'Song set', 0);

    INSERT INTO items
      (id, group_id, stack_id, kind, path, zh, artist, info_time, info_title, info_note,
       info_thumb, info_duration, info_uploader, info_songcut_text, special_effect, sort_order)
    VALUES
      (1, 1, NULL, 'normal', 'noise/a.mp3', 'Alpha', 'Artist A', '2026-10-09', 'Title', 'Note',
       '/thumbs/a.png', 12.5, ' Uploader A ', NULL, 1, 0),
      (2, 1, 1, 'normal', 'noise/b.mp3', 'Beta', NULL, NULL, NULL, NULL,
       NULL, 0, NULL, NULL, 0, 0),
      (3, 1, 1, 'normal', 'noise/c.mp3', 'Gamma', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 1),
      (4, 1, 2, 'normal', 'noise/d.mp3', 'Delta', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 0),
      (5, 1, NULL, 'hidden', 'noise/e.mp3', 'Hidden', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 0),
      (6, 2, NULL, 'normal', 'echo/a.mp3', 'Echo', 'Artist B', NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 0),
      (7, 3, NULL, 'normal', 'secret/a.mp3', 'Secret', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 0),
      (8, 4, 3, 'normal', 'songs/a.mp3', 'Song', 'Singer', NULL, NULL, NULL,
       NULL, NULL, NULL, ' 完整歌切见合集第二集 ', 0, 0),
      (9, 4, 3, 'normal', 'songs/b.mp3', 'Song 2', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 1),
      (10, 4, NULL, 'normal', 'songs/c.mp3', 'Song 3', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, 0, 0);

    INSERT INTO settings (key, value) VALUES
      ('voice_empty_hint', '暂无怪动静'),
      ('song_empty_hint', '暂无歌单');
  `);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

// ---------- mock D1 ----------

function d1Env(overrides = {}) {
  return {
    [CONTENT_SOURCE_ENV]: 'd1',
    [D1_ENV.accountId]: 'acct-test',
    [D1_ENV.databaseId]: 'db-test',
    [D1_ENV.token]: D1_TOKEN,
    [D1_ENV.baseUrl]: D1_BASE,
    ...overrides,
  };
}

/** 官方 D1 响应外壳：行数据放在 result[0].results。 */
function d1Response(rows) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: [{ success: true, results: rows, meta: {} }],
      }),
  };
}

/**
 * 用本地 SQLite 冒充 D1：把收到的 SQL 直接在本库执行，再按官方响应形状返回。
 * 行序故意反转，验证 d1 模式靠 assembleSection 重新排序，而不是依赖返回顺序。
 */
function fakeD1Fetch(db, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const rows = db
      .prepare(body.sql)
      .all(...(body.params ?? []))
      .reverse()
      .map((row) => JSON.parse(JSON.stringify(row)));
    return d1Response(rows);
  };
}

function createD1Source(db, calls = []) {
  return createContentSource({
    env: d1Env(),
    fetchImpl: fakeD1Fetch(db, calls),
    logger: { log() {} },
    timeoutMs: 5000,
  });
}

// ---------- local 模式 ----------

test('local 模式（默认）产出与 db.mjs loadSection 完全一致', async (t) => {
  const { db, dbPath } = fixture(t);
  const source = createContentSource({ env: {}, dbPath });
  try {
    assert.equal(source.mode, SOURCE_MODES.local);
    assert.ok(source.describe().startsWith('local（'));

    const voice = await source.loadSection('voice');
    assert.deepEqual(voice, loadSection(db, 'voice'));
    assert.equal(voice.hint, '暂无怪动静');
    assert.equal(voice.groups.length, 2);
    assert.equal(voice.secretGroup.groupName, 'forgotten');

    // 卡片元数据：空字段不输出、特殊图标是布尔值、上传者首尾空白被去掉。
    const alpha = voice.groups[0].voices[0];
    assert.deepEqual(alpha, {
      path: 'noise/a.mp3',
      zh: 'Alpha',
      artist: 'Artist A',
      specialEffect: true,
      info: {
        time: '2026-10-09',
        title: 'Title',
        note: 'Note',
        thumb: '/thumbs/a.png',
        duration: 12.5,
        uploader: 'Uploader A',
      },
    });
    assert.equal('specialEffect' in voice.groups[0].stacks[0].voices[0], false);
    assert.equal(voice.groups[0].stacks[0].voices[0].info.duration, 0, '0 秒时长必须保留');
    assert.equal('title' in voice.groups[0].stacks[1], false, '合集名为空时不输出 title');
    assert.deepEqual(
      voice.groups[0].hiddenVoices.map((item) => item.path),
      ['noise/e.mp3']
    );

    const song = await source.loadSection('song');
    assert.deepEqual(song, loadSection(db, 'song'));
    assert.equal(song.hint, '暂无歌单');
    assert.equal(
      song.groups[0].stacks[0].voices[0].info.songCutText,
      '完整歌切见合集第二集'
    );
  } finally {
    source.close();
  }
});

test('createLocalContentSource 注入 db 时 close() 不关闭调用方的连接', async (t) => {
  const { db } = fixture(t);
  const source = createLocalContentSource({ db });
  assert.equal((await source.loadSection('voice')).hint, '暂无怪动静');

  source.close();
  // close() 只处理自己创建的连接：注入的连接仍可查询（fixture 的 t.after 还要关闭它）。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 4);

  source.close(); // 幂等：重复关闭也不会碰调用方的连接
  assert.doesNotThrow(() => db.prepare('SELECT 1 AS n').get());
});

// ---------- CONTENT_SOURCE 解析 ----------

test('CONTENT_SOURCE 默认 local，无法识别时报明确错误', () => {
  assert.equal(resolveSourceMode({}), SOURCE_MODES.local);
  assert.equal(resolveSourceMode({ [CONTENT_SOURCE_ENV]: ' local ' }), SOURCE_MODES.local);
  assert.equal(resolveSourceMode({ [CONTENT_SOURCE_ENV]: 'D1' }), SOURCE_MODES.d1);

  assert.throws(
    () => resolveSourceMode({ [CONTENT_SOURCE_ENV]: 'cloudflare' }),
    (error) => {
      assert.match(error.message, /未知的 CONTENT_SOURCE="cloudflare"/);
      assert.match(error.message, /local/);
      assert.match(error.message, /d1/);
      return true;
    }
  );
  assert.throws(
    () => createContentSource({ env: { [CONTENT_SOURCE_ENV]: 'sqlite' } }),
    /未知的 CONTENT_SOURCE="sqlite"/
  );
});

// ---------- d1 模式 ----------

test('d1 模式用 mock fetch 产出与本地 loadSection 同形的 groups/items', async (t) => {
  const { db } = fixture(t);
  const calls = [];
  const source = createD1Source(db, calls);
  try {
    assert.equal(source.mode, SOURCE_MODES.d1);
    assert.ok(source.describe().startsWith('Cloudflare D1（database '));
    assert.equal(source.describe().includes(D1_TOKEN), false);

    for (const section of ['voice', 'song']) {
      assert.deepEqual(await source.loadSection(section), loadSection(db, section));
    }

    assert.equal(calls.length, 8, '每个栏目 4 个查询：分组 / 合集 / 条目 / 空提示');
    for (const call of calls) {
      assert.equal(call.url, D1_QUERY_URL);
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.headers.Authorization, `Bearer ${D1_TOKEN}`);
    }

    const sectionQueries = calls.filter((call) => /FROM (groups|stacks|items)/.test(call.body.sql));
    assert.equal(sectionQueries.length, 6);
    for (const call of sectionQueries) {
      assert.ok(['voice', 'song'].includes(call.body.params[0]), '栏目名应作为绑定参数');
      assert.match(call.body.sql, /LIMIT 100 OFFSET 0$/, 'selectAll 应自动分页');
    }

    const hintQueries = calls.filter((call) => /FROM settings/.test(call.body.sql));
    assert.deepEqual(
      hintQueries.map((call) => call.body.params[0]).sort(),
      ['song_empty_hint', 'voice_empty_hint']
    );
  } finally {
    source.close();
  }
});

test('两种模式产出的对象可 JSON 序列化且键顺序一致', async (t) => {
  const { db, dbPath } = fixture(t);
  const local = createContentSource({ env: {}, dbPath });
  const d1 = createD1Source(db);
  try {
    for (const section of ['voice', 'song']) {
      const fromLocal = await local.loadSection(section);
      const fromD1 = await d1.loadSection(section);
      const localJson = JSON.stringify(fromLocal);
      assert.equal(JSON.stringify(fromD1), localJson, 'D1 与 local 的 JSON 必须逐字节一致');
      assert.equal(
        JSON.stringify(JSON.parse(localJson)),
        localJson,
        'JSON 往返后键顺序不变'
      );
    }

    const voice = await d1.loadSection('voice');
    assert.deepEqual(Object.keys(voice), ['hint', 'groups', 'secretGroup']);
    assert.deepEqual(Object.keys(voice.groups[0]), [
      'groupName',
      'title',
      'voices',
      'stacks',
      'hiddenVoices',
    ]);
    assert.deepEqual(Object.keys(voice.groups[0].voices[0]), [
      'path',
      'zh',
      'artist',
      'specialEffect',
      'info',
    ]);
    assert.deepEqual(Object.keys(voice.groups[0].voices[0].info), [
      'time',
      'title',
      'note',
      'thumb',
      'duration',
      'uploader',
    ]);
    assert.deepEqual(Object.keys(voice.secretGroup), ['groupName', 'title', 'voices']);

    const song = await d1.loadSection('song');
    assert.deepEqual(Object.keys(song.groups[0]), ['groupName', 'title', 'voices', 'stacks']);
    assert.deepEqual(
      Object.keys(song.groups[0].stacks[0].voices[0].info),
      ['songCutText']
    );
  } finally {
    local.close();
    d1.close();
  }
});

test('d1 模式缺少凭据时抛 D1ConfigError，且不发起请求', () => {
  let requested = false;
  assert.throws(
    () =>
      createContentSource({
        env: { [CONTENT_SOURCE_ENV]: 'd1' },
        fetchImpl: async () => {
          requested = true;
          throw new Error('不应发起请求');
        },
      }),
    D1ConfigError
  );
  assert.equal(requested, false);
});

test('d1 模式把 D1 失败转成 D1ApiError，错误信息不含 token', async () => {
  const source = createContentSource({
    env: d1Env(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: `invalid token ${D1_TOKEN}` }],
          messages: [],
          result: [],
        }),
    }),
    logger: { log() {} },
    timeoutMs: 5000,
  });

  await assert.rejects(source.loadSection('voice'), (error) => {
    assert.ok(error instanceof D1ApiError);
    assert.match(error.message, /\[REDACTED\]/);
    assert.equal(error.message.includes(D1_TOKEN), false);
    return true;
  });
  source.close();
});

// ---------- 纯函数（与 db.mjs 共享的拼装逻辑） ----------

test('assembleSection 按 sort_order/id 排序并单独返回保密分组', () => {
  const section = assembleSection({
    hint: '空提示',
    groupRows: [
      { id: 2, group_name: 'b', title: 'B', sort_order: 1, is_secret: 0 },
      { id: 1, group_name: 'a', title: 'A', sort_order: 0, is_secret: 0 },
      { id: 3, group_name: 'secret', title: 'Secret', sort_order: 2, is_secret: 1 },
      { id: 4, group_name: 'empty', title: 'Empty', sort_order: 3, is_secret: 0 },
    ],
    stackRows: [
      { id: 12, group_id: 1, title: '', sort_order: 1 },
      { id: 11, group_id: 1, title: 'Stack', sort_order: 0 },
      { id: 99, group_id: 999, title: 'Orphan', sort_order: 0 },
    ],
    itemRows: [
      { id: 22, group_id: 1, stack_id: 11, kind: 'normal', path: 'p/2.mp3', zh: '2', sort_order: 1 },
      { id: 21, group_id: 1, stack_id: null, kind: 'normal', path: 'p/1.mp3', zh: '1', sort_order: 0 },
      { id: 23, group_id: 1, stack_id: null, kind: 'hidden', path: 'p/h.mp3', zh: 'H', sort_order: 0 },
      { id: 98, group_id: 999, kind: 'normal', path: 'p/x.mp3', zh: 'X', sort_order: 0 },
    ],
  });

  assert.equal(section.hint, '空提示');
  assert.deepEqual(
    section.groups.map((group) => group.groupName),
    ['a', 'b', 'empty']
  );
  assert.deepEqual(section.secretGroup, {
    groupName: 'secret',
    title: 'Secret',
    voices: [],
  });

  const first = section.groups[0];
  assert.deepEqual(first, {
    groupName: 'a',
    title: 'A',
    voices: [{ path: 'p/1.mp3', zh: '1' }],
    stacks: [
      { title: 'Stack', voices: [{ path: 'p/2.mp3', zh: '2' }] },
      { voices: [] },
    ],
    hiddenVoices: [{ path: 'p/h.mp3', zh: 'H' }],
  });
  assert.deepEqual(section.groups[1], { groupName: 'b', title: 'B', voices: [] });
  assert.deepEqual(section.groups[2], { groupName: 'empty', title: 'Empty', voices: [] });
  assert.equal('stacks' in section.groups[1], false);
  assert.equal('hiddenVoices' in section.groups[1], false);
});

test('toVoiceRow 省略空字段并保留 0 秒时长', () => {
  assert.deepEqual(toVoiceRow({ path: 'a.mp3', zh: 'A' }), { path: 'a.mp3', zh: 'A' });
  assert.deepEqual(
    toVoiceRow({
      path: 'b.mp3',
      zh: 'B',
      artist: '',
      special_effect: 0,
      info_time: '',
      info_title: null,
      info_note: undefined,
      info_thumb: '',
      info_duration: 0,
      info_uploader: '  ',
      info_songcut_text: '\n',
    }),
    { path: 'b.mp3', zh: 'B', info: { duration: 0 } }
  );
});
