import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { publicMediaMiddleware } from '../scripts/lib/public-media-plugin.mjs';
import { indexedFlacHeader, prepareAudio } from '../scripts/lib/audio-prepare.mjs';

test('reserved file names survive exactly one decode, HEAD, byte ranges and conditional GET', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesing-public-'));
  fs.mkdirSync(path.join(root, 'audio'));
  const bytes = Buffer.from('Valid media fixture body');
  const name = '中文 空格 #1%.wav';
  fs.writeFileSync(path.join(root, 'audio', name), bytes);
  fs.writeFileSync(path.join(root, 'audio', '%23.wav'), bytes);
  fs.writeFileSync(path.join(root, 'audio', '#.txt'), 'not media');
  const middleware = publicMediaMiddleware(root, '/site/');
  const server = http.createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin + '/site/audio/' + encodeURIComponent(name);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [['bytes=1-4', 1, 4], ['bytes=-4', bytes.length - 4, bytes.length - 1], ['bytes=4-', 4, bytes.length - 1]]) {
    const partial = await fetch(url, { headers: { Range: range } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=999-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,3-4']) {
    const invalid = await fetch(url, { headers: { Range: range } });
    assert.equal(invalid.status, 416);
    await invalid.arrayBuffer();
  }
  assert.equal((await fetch(url, { headers: { 'If-None-Match': head.headers.get('etag') } })).status, 304);
  const singleDecode = await fetch(origin + '/site/audio/%2523.wav');
  assert.equal(singleDecode.status, 200);
  await singleDecode.arrayBuffer();
  for (const suffix of ['/site/audio/%23.txt', '/audio/%231.wav', '/site/audio/missing%23.wav', '/site/audio/%23%2f..%2f..%2fsecret.wav', '/site/audio/%25%5csecret.wav']) {
    const denied = await fetch(origin + suffix);
    assert.ok([403, 404].includes(denied.status), suffix);
    await denied.arrayBuffer();
  }
});

test('FLAC indexing preserves metadata and uses frame-relative offsets without changing audio', () => {
  const original = Buffer.alloc(42);
  original.write('fLaC');
  original[4] = 0x80;
  original.writeUIntBE(34, 5, 3);
  const packets = [
    { pts: 0, pos: '42', duration: 4096 },
    { pts: 4096, pos: '142', duration: 2000 },
  ];
  const result = indexedFlacHeader(original, packets);
  assert.equal(result.audioOffset, 42);
  assert.equal(result.seekPoints, 2);
  assert.deepEqual(result.header.subarray(8, 42), original.subarray(8));
  assert.equal(result.header[42], 0x83);
  assert.equal(result.header.readUIntBE(43, 3), 36);
  assert.equal(result.header.readBigUInt64BE(46), 0n);
  assert.equal(result.header.readBigUInt64BE(46 + 18), 4096n);
  assert.equal(result.header.readBigUInt64BE(46 + 18 + 8), 100n);
  assert.throws(() => indexedFlacHeader(original, [{ pts: 0, pos: '99', duration: 4096 }]));
  assert.throws(() => indexedFlacHeader(original.subarray(0, 30), packets));
});

test('audio preparation refuses overwriting input or existing files before launching tools', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesing-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.flac');
  fs.writeFileSync(file, 'keep');
  await assert.rejects(prepareAudio({ input: file, output: file }), /不会覆盖/);
  await assert.rejects(prepareAudio({ input: file, output: path.join(dir, 'wrong.mp3') }), /仅支持/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});
