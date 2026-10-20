import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, backupDatabase, exportDump, loadSection, upgradeCardMetadata, SCHEMA_PATH } from '../scripts/lib/db.mjs';
import { addItem, removeExamples, exampleCleanupPlan, normalizeAudioPath, dumpTarget } from '../scripts/lib/content-operations.mjs';
import { restoreDatabase } from '../scripts/content-migrate.mjs';
import { verifyContent, decodeHtml } from '../scripts/lib/content-verification.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesing-content-test-'));
  const dbPath = path.join(dir, 'content.db');
  const db = openDb({ create: true, dbPath });
  db.exec("INSERT INTO groups (section, group_name, title) VALUES ('voice', 'noise', 'Noise');");
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function legacyFixture(t) {
  const result = fixture(t);
  result.db.exec(`
    DROP VIEW v_items;
    ALTER TABLE items DROP COLUMN info_duration;
    ALTER TABLE items DROP COLUMN info_uploader;
    ALTER TABLE items DROP COLUMN info_songcut_text;
    CREATE VIEW v_items AS SELECT id, path FROM items;
  `);
  return result;
}

test('card metadata survives JSON export and SQL snapshot restoration', (t) => {
  const { db, dir } = fixture(t);
  addItem(db, { group: 'noise', zh: 'Single', path: 'noise/a.mp3', duration: '12.5', uploader: " Uploader's 中文 " });
  addItem(db, { group: 'noise', zh: 'Member', path: 'noise/b.mp3', stack: 'Stack', duration: 0, uploader: 'Member uploader' });
  addItem(db, { group: 'noise', zh: 'Hidden', path: 'noise/c.mp3', hidden: true, duration: 3665, uploader: 'Hidden uploader' });
  const group = loadSection(db, 'voice').groups[0];
  assert.deepEqual(group.voices[0].info, { duration: 12.5, uploader: "Uploader's 中文" });
  assert.equal(group.stacks[0].voices[0].info.duration, 0);
  assert.equal(group.hiddenVoices[0].info.uploader, 'Hidden uploader');
  const dumpPath = path.join(dir, 'metadata.sql');
  exportDump(db, dumpPath);
  const dbPath = path.join(dir, 'metadata.db');
  restoreDatabase({ dbPath, dumpPath });
  const restored = openDb({ readOnly: true, dbPath });
  try {
    assert.deepEqual(loadSection(restored, 'voice'), loadSection(db, 'voice'));
    assert.equal(restored.prepare('SELECT info_duration, info_uploader FROM v_items WHERE id = 1').get().info_duration, 12.5);
  } finally {
    restored.close();
  }
});

test('invalid duration options do not create content or collections', (t) => {
  const { db } = fixture(t);
  for (const duration of [true, null, '', '  ', 'bad', '-1', '-Infinity', 'Infinity', NaN, Number.MAX_VALUE]) {
    assert.throws(() => addItem(db, { group: 'noise', zh: 'Invalid', path: 'noise/a.mp3', stack: 'Orphan', duration }));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
});

test('old databases remain readable and writable without new metadata', (t) => {
  const { db, dir } = legacyFixture(t);
  addItem(db, { group: 'noise', zh: 'Legacy', path: 'noise/a.mp3', title: 'Old title' });
  const original = loadSection(db, 'voice');
  assert.deepEqual(original.groups[0].voices[0].info, { title: 'Old title' });
  assert.throws(() => addItem(db, { group: 'noise', zh: 'New', path: 'noise/b.mp3', duration: 0, stack: 'Orphan' }), /content:upgrade/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
  const dumpPath = path.join(dir, 'legacy.sql');
  exportDump(db, dumpPath);
  const dbPath = path.join(dir, 'restored-legacy.db');
  restoreDatabase({ dbPath, dumpPath });
  const restored = openDb({ readOnly: true, dbPath });
  try {
    assert.deepEqual(loadSection(restored, 'voice'), original);
  } finally {
    restored.close();
  }
});

test('metadata upgrade backs up old data and is idempotent', async (t) => {
  const { db, dbPath } = legacyFixture(t);
  addItem(db, { group: 'noise', zh: 'Legacy', path: 'noise/a.mp3', note: 'Keep' });
  const original = loadSection(db, 'voice');
  const result = await upgradeCardMetadata(db, { dbPath });
  assert.equal(result.changed, true);
  assert.deepEqual(loadSection(db, 'voice'), original);
  assert.equal(db.prepare('SELECT info_duration, info_uploader FROM v_items').get().info_duration, null);
  const snapshot = openDb({ readOnly: true, dbPath: result.backupFile });
  try {
    assert.equal(snapshot.prepare('PRAGMA table_info(items)').all().some((column) => column.name === 'info_duration'), false);
    assert.deepEqual(loadSection(snapshot, 'voice'), original);
  } finally {
    snapshot.close();
  }
  assert.deepEqual(await upgradeCardMetadata(db, { dbPath }), { changed: false });
  assert.equal(fs.readdirSync(path.dirname(result.backupFile)).length, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('metadata upgrade supports partial schemas and rolls back on failure', async (t) => {
  const { db, dbPath, dir } = legacyFixture(t);
  db.exec('ALTER TABLE items ADD COLUMN info_duration REAL;');
  addItem(db, { group: 'noise', zh: 'Partial', path: 'noise/a.mp3', duration: 12.5 });
  const invalidSchema = path.join(dir, 'invalid-schema.sql');
  fs.writeFileSync(invalidSchema, 'INVALID SQL;');
  await assert.rejects(upgradeCardMetadata(db, { dbPath, schemaPath: invalidSchema }));
  assert.equal(db.prepare('PRAGMA table_info(items)').all().some((column) => column.name === 'info_uploader'), false);
  assert.equal(db.prepare('SELECT * FROM v_items').get().path, 'noise/a.mp3');
  assert.equal(db.isTransaction, false);
  await upgradeCardMetadata(db, { dbPath });
  assert.equal(loadSection(db, 'voice').groups[0].voices[0].info.duration, 12.5);
});

test('metadata upgrade also refreshes an old view when all optional columns already exist', async (t) => {
  const { db, dbPath } = legacyFixture(t);
  db.exec('ALTER TABLE items ADD COLUMN info_duration REAL; ALTER TABLE items ADD COLUMN info_uploader TEXT;');
  db.exec('ALTER TABLE items ADD COLUMN info_songcut_text TEXT;');
  addItem(db, { group: 'noise', zh: 'Manual upgrade', path: 'noise/a.mp3', duration: 5, uploader: 'Uploader' });
  const result = await upgradeCardMetadata(db, { dbPath });
  assert.equal(result.changed, true);
  assert.equal(db.prepare('SELECT info_uploader FROM v_items').get().info_uploader, 'Uploader');
});

test('song-cut text round-trips in song JSON and SQL backups without a URL', (t) => {
  const { db, dir } = fixture(t);
  db.exec("INSERT INTO groups (section, group_name, title) VALUES ('song', 'covers', 'Covers');");
  const text = "看这段'完整歌切'：合集第二集\n从副歌开始";
  addItem(db, {
    section: 'song', group: 'covers', zh: 'Song', path: 'songs/a.mp3', artist: 'Artist',
    'songcut-text': ` ${text} `,
  });
  const info = loadSection(db, 'song').groups[0].voices[0].info;
  assert.deepEqual(info, { songCutText: text });
  const dumpPath = path.join(dir, 'song-cut.sql');
  exportDump(db, dumpPath);
  const dbPath = path.join(dir, 'restored-song-cut.db');
  restoreDatabase({ dbPath, dumpPath });
  const restored = openDb({ readOnly: true, dbPath });
  try {
    assert.deepEqual(loadSection(restored, 'song'), loadSection(db, 'song'));
    assert.equal(restored.prepare('SELECT info_songcut_text FROM v_items').get().info_songcut_text, text);
  } finally {
    restored.close();
  }
});

test('invalid song-cut text options do not create rows or collections', (t) => {
  const { db } = fixture(t);
  db.exec("INSERT INTO groups (section, group_name, title) VALUES ('song', 'covers', 'Covers');");
  for (const options of [
    { 'songcut-text': true },
    { 'songcut-text': 123 },
    { 'songcut-text': null },
    { section: 'voice', group: 'noise', 'songcut-text': 'Label' },
  ]) {
    assert.throws(() => addItem(db, { section: 'song', group: 'covers', zh: 'Invalid', path: 'songs/a.mp3', stack: 'Orphan', ...options }));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
});

test('blank song-cut text is omitted from exported metadata', (t) => {
  const { db } = fixture(t);
  db.exec("INSERT INTO groups (section, group_name, title) VALUES ('song', 'covers', 'Covers');");
  addItem(db, { section: 'song', group: 'covers', zh: 'Blank', path: 'songs/a.mp3', 'songcut-text': ' \n ' });
  assert.equal(loadSection(db, 'song').groups[0].voices[0].info, undefined);
  assert.equal(db.prepare('SELECT info_songcut_text FROM items').get().info_songcut_text, null);
});

test('upgrade from duration/uploader schema preserves those values and adds song-cut text', async (t) => {
  const { db, dbPath } = fixture(t);
  addItem(db, { group: 'noise', zh: 'Current', path: 'noise/a.mp3', duration: 12.5, uploader: 'Uploader' });
  db.exec('DROP VIEW v_items; ALTER TABLE items DROP COLUMN info_songcut_text;');
  const original = db.prepare('SELECT * FROM items').all();
  db.exec("INSERT INTO groups (section, group_name, title) VALUES ('song', 'covers', 'Covers');");
  assert.throws(() => addItem(db, {
    section: 'song', group: 'covers', zh: 'Not upgraded', path: 'songs/a.mp3', stack: 'Orphan', 'songcut-text': '合集第二集',
  }), /content:upgrade/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
  const result = await upgradeCardMetadata(db, { dbPath });
  assert.equal(result.changed, true);
  const current = db.prepare('SELECT * FROM items').all().map((row) => {
    assert.equal(row.info_songcut_text, null);
    delete row.info_songcut_text;
    return row;
  });
  assert.deepEqual(current, original);
  assert.equal(db.prepare('SELECT info_songcut_text FROM v_items').get().info_songcut_text, null);
  assert.deepEqual(await upgradeCardMetadata(db, { dbPath }), { changed: false });
});

test('content paths preserve local paths and accept HTTP(S) audio links', () => {
  assert.equal(normalizeAudioPath(' noise\\音频 #1%.mp3 '), 'noise/音频 #1%.mp3');
  assert.equal(normalizeAudioPath(' https://host/a.mp3?Signature=a%2Fb%2B&Expires=123 '), 'https://host/a.mp3?Signature=a%2Fb%2B&Expires=123');
  for (const input of ['', '../other.mp3', '/noise/a.mp3', 'C:\\a.mp3', 'noise//a.mp3', 'public/audio/a.mp3', '//host/a.mp3', 'https://', 'https://host\\a.mp3', 'https://user:pass@host/a.mp3', 'javascript:alert(1)']) {
    assert.throws(() => normalizeAudioPath(input));
  }
});

test('remote audio and image metadata round-trip without changing signatures or key case', (t) => {
  const { db } = fixture(t);
  const audio = 'https://bucket.example.test/audio/A.mp3?Signature=a%2Fb%2B&Expires=123';
  const thumb = 'https://images.example.test/cover.webp?imageMogr2/thumbnail/320x&token=a%2B';
  addItem(db, { group: 'noise', zh: 'Remote', path: audio, thumb });
  addItem(db, { group: 'noise', zh: 'Different object', path: audio.replace('/A.mp3', '/a.mp3') });
  assert.throws(() => addItem(db, { group: 'noise', zh: 'Duplicate', path: audio, stack: 'Orphan' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
  const voices = loadSection(db, 'voice').groups[0].voices;
  assert.equal(voices[0].path, audio);
  assert.equal(voices[0].info.thumb, thumb);
  assert.equal(voices.length, 2);
});

test('dump targets cannot replace the database, schema or files outside data', (t) => {
  const { dir } = fixture(t);
  assert.equal(dumpTarget('snapshots/content.sql', dir), path.join(dir, 'snapshots', 'content.sql'));
  for (const target of ['../outside.sql', 'content.db', 'schema.sql', 'SCHEMA.SQL', path.join(dir, 'absolute.sql')]) {
    assert.throws(() => dumpTarget(target, dir));
  }
});

test('adding content preserves desktop-compatible metadata and ordering', (t) => {
  const { db } = fixture(t);
  const item = addItem(db, {
    group: 'noise', zh: ' First ', path: 'noise/first.mp3', stack: 'Collection',
    artist: ' Artist ', time: '2026-10-09', title: 'Title', note: 'Note', thumb: '/thumbs/a.png',
  });
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
  assert.equal(row.artist, 'Artist');
  assert.equal(row.is_example, 0);
  assert.equal(row.stack_id, item.stackId);
  assert.equal(row.info_note, 'Note');
  assert.equal(loadSection(db, 'voice').groups[0].stacks[0].voices[0].info.thumb, '/thumbs/a.png');
});

test('duplicate content does not create an orphan collection', (t) => {
  const { db } = fixture(t);
  addItem(db, { group: 'noise', zh: 'First', path: 'noise/a.mp3' });
  assert.throws(() => addItem(db, { group: 'noise', zh: 'Duplicate', path: 'noise/A.mp3', stack: 'New' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
});

test('failed item insertion rolls back collection creation', (t) => {
  const { db } = fixture(t);
  db.exec("CREATE TRIGGER reject_item BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => addItem(db, { group: 'noise', zh: 'First', path: 'noise/a.mp3', stack: 'New' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 0);
  assert.equal(db.isTransaction, false);
});

test('example cleanup retains real items in an example collection', (t) => {
  const { db } = fixture(t);
  addItem(db, { group: 'noise', zh: 'Example', path: 'noise/example.mp3', stack: 'Mixed', example: true });
  const real = addItem(db, { group: 'noise', zh: 'Real', path: 'noise/real.mp3', stack: 'Mixed' });
  addItem(db, { group: 'noise', zh: 'Example 2', path: 'noise/example2.mp3', stack: 'Disposable', example: true });
  const plan = exampleCleanupPlan(db);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.removable, 1);
  assert.equal(plan.retained, 1);
  removeExamples(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 1);
  assert.equal(db.prepare('SELECT id FROM items').get().id, real.id);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('example cleanup failures roll back all deletions', (t) => {
  const { db } = fixture(t);
  addItem(db, { group: 'noise', zh: 'Example', path: 'noise/example.mp3', stack: 'Disposable', example: true });
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON stacks BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => removeExamples(db));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stacks').get().n, 1);
});

test('read-only queries cannot modify the desktop content database', (t) => {
  const { dbPath } = fixture(t);
  const reader = openDb({ readOnly: true, dbPath });
  try {
    assert.throws(() => reader.exec('DELETE FROM groups'));
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM groups').get().n, 1);
  } finally {
    reader.close();
  }
});

test('online backup includes committed content still in WAL', async (t) => {
  const { db, dbPath } = fixture(t);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  addItem(db, { group: 'noise', zh: 'WAL item', path: 'noise/wal.mp3' });
  const snapshot = await backupDatabase(db, dbPath);
  const reader = openDb({ readOnly: true, dbPath: snapshot });
  try {
    assert.equal(reader.prepare('SELECT zh FROM items').get().zh, 'WAL item');
    assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    reader.close();
  }
});

test('SQL snapshot restores all metadata and deleted high ids without overwriting', (t) => {
  const { db, dir, dbPath } = fixture(t);
  addItem(db, { group: 'noise', zh: "Quote's 中文", path: 'noise/a.mp3', stack: 'Collection', example: true });
  db.exec("UPDATE items SET created_at = '2024-01-02 03:04:05';");
  db.exec("INSERT INTO items (id, group_id, path, zh) VALUES (100, 1, 'deleted.mp3', 'Deleted'); DELETE FROM items WHERE id = 100;");
  const dumpPath = path.join(dir, 'snapshot.sql');
  assert.equal(exportDump(db, dumpPath), true);
  assert.equal(exportDump(db, dumpPath), false);
  const before = createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  assert.throws(() => restoreDatabase({ dbPath, schemaPath: SCHEMA_PATH, dumpPath }));
  assert.equal(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'), before);
  const restoredPath = path.join(dir, 'restored.db');
  restoreDatabase({ dbPath: restoredPath, schemaPath: SCHEMA_PATH, dumpPath });
  const restored = openDb({ dbPath: restoredPath });
  try {
    assert.deepEqual(restored.prepare('SELECT * FROM items').all(), db.prepare('SELECT * FROM items').all());
    const result = addItem(restored, { group: 'noise', zh: 'New', path: 'noise/new.mp3' });
    assert.equal(result.id, 101);
  } finally {
    restored.close();
  }
});

test('invalid SQL snapshot never publishes a partial database', (t) => {
  const { dir } = fixture(t);
  const dumpPath = path.join(dir, 'invalid.sql');
  const restoredPath = path.join(dir, 'restored.db');
  fs.writeFileSync(dumpPath, "BEGIN; INSERT INTO groups (section, group_name, title) VALUES ('voice', 'test', 'Test');");
  assert.throws(() => restoreDatabase({ dbPath: restoredPath, schemaPath: SCHEMA_PATH, dumpPath }));
  assert.equal(fs.existsSync(restoredPath), false);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

test('build verification accepts secret content in JS instead of initial HTML', () => {
  const content = {
    voice: {
      hint: '',
      groups: [],
      secretGroup: {
        groupName: 'secret', title: 'Secret', voices: [{ zh: 'Secret single', path: 'secret/a.mp3' }],
        stacks: [{ title: 'Secret collection', voices: [{ zh: 'Secret member', path: 'secret/b.mp3' }] }],
      },
    },
  };
  const js = JSON.stringify(content);
  assert.deepEqual(verifyContent(content, { voice: '', song: '' }, js).problems, []);
  assert.equal(verifyContent(content, { voice: '', song: '' }, '').problems.length > 0, true);
});

test('build verification handles HTML entities and escaped JS text separately', () => {
  const content = {
    voice: {
      hint: '',
      groups: [{ groupName: 'quotes', title: 'A &amp; B', voices: [{ zh: 'Quote " &', path: 'noise/a.mp3', info: { note: 'Line 1\nLine 2 &amp;' } }] }],
    },
  };
  const html = { voice: 'A &amp;amp; B Quote &quot; &amp;', song: '' };
  assert.deepEqual(verifyContent(content, html, JSON.stringify(content)).problems, []);
  assert.equal(decodeHtml('&#39; &#x4e2d; &amp;amp;'), "' 中 &amp;");
});

test('build verification checks uploader and numeric duration, including zero', () => {
  const content = {
    voice: {
      hint: '',
      groups: [{
        groupName: 'metadata', title: 'Metadata',
        voices: [{ zh: 'Clip', path: 'clip.mp3', info: { duration: 323.75, uploader: 'Uploader label' } }],
      }],
    },
  };
  assert.deepEqual(verifyContent(content, { voice: 'Metadata Clip' }, JSON.stringify(content)).problems, []);
  const missing = verifyContent(content, { voice: 'Metadata Clip' }, 'Clip clip.mp3');
  assert.equal(missing.problems.length, 2);
  content.voice.groups[0].voices[0].info.duration = 0;
  assert.equal(verifyContent(content, { voice: 'Metadata Clip' }, JSON.stringify(content)).fieldCount, 4);
});

test('build verification checks song-cut information text', () => {
  const content = {
    song: {
      hint: '',
      groups: [{ groupName: 'cuts', title: 'Cuts', voices: [{
        zh: 'Song', path: 'songs/a.mp3',
        info: { songCutText: '完整歌切见合集第二集' },
      }] }],
    },
  };
  assert.deepEqual(verifyContent(content, { song: 'Cuts Song' }, JSON.stringify(content)).problems, []);
  assert.equal(verifyContent(content, { song: 'Cuts Song' }, 'Song songs/a.mp3').problems.length, 1);
});
