// 旧 TS 数据已经改成读取生成物，不能再作为独立迁移源。
// 此命令仅从 SQL 快照恢复缺失的数据库，绝不覆盖现有内容。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH, SCHEMA_PATH, DATA_DIR } from './lib/db.mjs';

export function restoreDatabase({
  dbPath = DB_PATH,
  schemaPath = SCHEMA_PATH,
  dumpPath = path.join(DATA_DIR, 'content-dump.sql'),
} = {}) {
  if (fs.existsSync(dbPath)) throw new Error('数据库已存在，拒绝覆盖。请先备份并人工确认恢复方案。');
  const dump = fs.readFileSync(dumpPath, 'utf8');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporary = `${dbPath}.${randomUUID()}.tmp`;
  let db;
  try {
    db = openDb({ create: true, dbPath: temporary, schemaPath });
    db.exec(dump);
    if (db.isTransaction) throw new Error('SQL 快照缺少 COMMIT，拒绝恢复未提交的内容。');
    const integrity = db.prepare('PRAGMA integrity_check;').get().integrity_check;
    if (integrity !== 'ok' || db.prepare('PRAGMA foreign_key_check;').all().length) {
      throw new Error('SQL 快照未通过完整性检查。');
    }
    db.prepare('SELECT id, group_id, stack_id, path, zh, created_at FROM items').all();
    db.close();
    db = undefined;
    fs.copyFileSync(temporary, dbPath, fs.constants.COPYFILE_EXCL);
    return dbPath;
  } finally {
    db?.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(temporary + suffix, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length) throw new Error('不支持 --force 或其他覆盖参数；现有数据库不会被删除。');
    console.log(`已从 SQL 快照恢复：${restoreDatabase()}`);
    console.log('下一步：pnpm content:sync');
  } catch (error) {
    console.error(`恢复未执行：${error.message}`);
    process.exitCode = 1;
  }
}
