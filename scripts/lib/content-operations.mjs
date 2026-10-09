import path from 'node:path';
import { withTransaction, DATA_DIR } from './db.mjs';

export function dumpTarget(fileName = 'content-dump.sql', dataDir = DATA_DIR) {
  if (typeof fileName !== 'string' || !fileName.trim() || path.isAbsolute(fileName) || path.win32.isAbsolute(fileName)) {
    throw new Error('快照文件名必须是 data 目录内的相对路径。');
  }
  const target = path.resolve(dataDir, fileName);
  const relative = path.relative(dataDir, target);
  if (
    !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
    path.extname(target).toLowerCase() !== '.sql' ||
    target.toLowerCase() === path.join(dataDir, 'schema.sql').toLowerCase()
  ) {
    throw new Error('只允许导出到 data 目录内的 .sql 快照，不能覆盖 schema.sql 或数据库。');
  }
  return target;
}

/** 路径约定与桌面工具一致；文件不存在只提醒，不阻止内容入库。 */
export function normalizeAudioPath(value) {
  if (typeof value !== 'string') throw new Error('音频路径必须是文字。');
  const audioPath = value.trim().replace(/\\/g, '/');
  const segments = audioPath.split('/');
  if (
    !audioPath ||
    /[<>:"|?*\u0000-\u001f\u007f-\u009f]/.test(audioPath) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments[0].toLowerCase() === 'public'
  ) {
    throw new Error('音频路径必须相对 public/audio，不能带盘符、网址或跳出目录。');
  }
  return audioPath;
}

export function addItem(db, { group, section = 'voice', zh, path: inputPath, ...options }) {
  if (section !== 'voice' && section !== 'song') throw new Error('--section 只能是 voice 或 song。');
  if (typeof group !== 'string' || !group.trim() || typeof zh !== 'string' || !zh.trim()) {
    throw new Error('请提供 --group <分组>、--zh <文字> 和 --path <音频路径>。');
  }
  const audioPath = normalizeAudioPath(inputPath);
  const optionalText = (value, field) => {
    if (value === undefined) return null;
    if (typeof value !== 'string') throw new Error(`--${field} 后需要填写文字。`);
    return value.trim() || null;
  };
  const stackTitle = optionalText(options.stack, 'stack');
  const metadata = ['artist', 'time', 'title', 'note', 'thumb'].map((field) => optionalText(options[field], field));

  return withTransaction(db, () => {
    const matches = db.prepare(
      'SELECT * FROM groups WHERE section = ? AND (group_name = ? OR title = ?)'
    ).all(section, group.trim(), group.trim());
    const g = matches.find((row) => row.group_name === group.trim()) ?? (matches.length === 1 ? matches[0] : null);
    if (!g) throw new Error('分组不存在或标题不唯一，请用 content:groups 中的分组 id。');

    const duplicate = db.prepare('SELECT id, path FROM items WHERE group_id = ?').all(g.id)
      .find((row) => row.path.replace(/\\/g, '/').toLowerCase() === audioPath.toLowerCase());
    if (duplicate) throw new Error(`同一分组内已存在相同音频路径（id=${duplicate.id}）：${audioPath}`);

    let stackId = null;
    if (stackTitle) {
      const existing = db.prepare(
        'SELECT id FROM stacks WHERE group_id = ? AND title = ? ORDER BY sort_order, id LIMIT 1'
      ).get(g.id, stackTitle);
      if (existing) stackId = existing.id;
      else {
        const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM stacks WHERE group_id = ?').get(g.id).n;
        stackId = Number(db.prepare(
          'INSERT INTO stacks (group_id, title, sort_order, is_example) VALUES (?, ?, ?, ?)'
        ).run(g.id, stackTitle, order, options.example ? 1 : 0).lastInsertRowid);
      }
    }
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM items WHERE group_id = ?').get(g.id).n;
    const kind = options.hidden ? 'hidden' : 'normal';
    const result = db.prepare(
      `INSERT INTO items (group_id, stack_id, kind, path, zh, artist,
                          info_time, info_title, info_note, info_thumb, sort_order, is_example)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(g.id, stackId, kind, audioPath, zh.trim(), ...metadata, order, options.example ? 1 : 0);
    return { id: Number(result.lastInsertRowid), group: g, stackId, kind, path: audioPath, zh: zh.trim() };
  });
}

export function exampleCleanupPlan(db) {
  const items = db.prepare(
    `SELECT i.id, g.title AS g, i.zh, i.path FROM items i JOIN groups g ON g.id = i.group_id
     WHERE i.is_example = 1 ORDER BY g.section DESC, g.sort_order, i.id`
  ).all();
  const { removable, retained } = db.prepare(
    `SELECT
       COALESCE(SUM(NOT EXISTS (SELECT 1 FROM items i WHERE i.stack_id = s.id AND i.is_example = 0)), 0) AS removable,
       COALESCE(SUM(EXISTS (SELECT 1 FROM items i WHERE i.stack_id = s.id AND i.is_example = 0)), 0) AS retained
     FROM stacks s WHERE s.is_example = 1`
  ).get();
  return { items, removable, retained };
}

export function removeExamples(db) {
  return withTransaction(db, () => {
    const plan = exampleCleanupPlan(db);
    db.prepare('DELETE FROM items WHERE is_example = 1').run();
    db.prepare(
      `DELETE FROM stacks WHERE is_example = 1
       AND NOT EXISTS (SELECT 1 FROM items WHERE items.stack_id = stacks.id)`
    ).run();
    return plan;
  });
}
