import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, exportDump, loadSection } from '../scripts/lib/db.mjs';
import { restoreDatabase } from '../scripts/content-migrate.mjs';

test('private audio locations and cleanup survive SQL restoration without entering browser JSON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesing-audio-catalog-'));
  const db = openDb({ create: true, dbPath: path.join(dir, 'source.db') });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`
    INSERT INTO groups(section,group_name,title) VALUES('voice','noise','Noise');
    INSERT INTO items(group_id,path,zh) VALUES(1,'noise/online.mp3','Remote');
  `);
  const asset = JSON.stringify({
    Storage: 'server', Location: '/srv/site/audio/noise/online.mp3',
    PlaybackPath: 'noise/online.mp3', Sha256: 'a'.repeat(64), Bytes: 42, Authority: 'studio@example:22/srv/site',
  });
  db.prepare('INSERT INTO item_audio(item_id,tag,asset_json) VALUES(?,?,?)').run(1, 'wesing-audio/v1', asset);
  db.prepare('INSERT INTO audio_cleanup(asset_json,tag) VALUES(?,?)').run(asset, 'wesing-audio/v1');
  db.prepare('INSERT INTO audio_retired(asset_json,tag) VALUES(?,?)').run(asset, 'wesing-audio/v1');
  const browser = JSON.stringify(loadSection(db, 'voice'));
  assert.equal(browser.includes('/srv/site'), false);
  assert.equal(browser.includes('Sha256'), false);
  assert.equal(browser.includes('noise/online.mp3'), true);
  const dumpPath = path.join(dir, 'audio.sql');
  exportDump(db, dumpPath);
  const dbPath = path.join(dir, 'audio-restored.db');
  restoreDatabase({ dbPath, dumpPath });
  const restored = openDb({ dbPath });
  try {
    for (const table of ['item_audio', 'audio_cleanup', 'audio_retired']) {
      assert.deepEqual(restored.prepare(`SELECT * FROM ${table}`).all(), db.prepare(`SELECT * FROM ${table}`).all());
    }
    restored.prepare('DELETE FROM items WHERE id = ?').run(1);
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM item_audio').get().n, 0);
  } finally {
    restored.close();
  }
});
