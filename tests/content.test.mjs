import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, backupDatabase, exportDump, loadSection, SCHEMA_PATH } from '../scripts/lib/db.mjs';
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
