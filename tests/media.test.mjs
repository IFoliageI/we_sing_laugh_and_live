import test from 'node:test';
import assert from 'node:assert/strict';
import { audioUrl, imageUrl } from '../src/lib/media.ts';
import { isRemoteMediaUrl, normalizeMediaBaseUrl } from '../src/lib/media-url.mjs';
import { createAudioPlayer } from '../src/lib/audio-player.ts';

test('OSS and image-host direct links keep signed query strings byte-for-byte', () => {
  const audio = 'https://bucket.example.test/a%20b.mp3?Expires=123&Signature=A%2Fb%2Bc%3D';
  const image = 'https://img.example.test/a.webp?x-oss-process=image/resize,w_320&token=a%2B';
  assert.equal(audioUrl(audio, 'https://other.example.test/audio'), audio);
  assert.equal(imageUrl(image, 'https://other.example.test/images'), image);
  assert.equal(audioUrl('http://localhost:9000/audio.mp3'), 'http://localhost:9000/audio.mp3');
});

test('relative media uses the configured resource directory and encodes file names once', () => {
  assert.equal(audioUrl('songs/曲 #1%.mp3', 'https://cdn.example.test/assets/audio/'), 'https://cdn.example.test/assets/audio/songs/%E6%9B%B2%20%231%25.mp3');
  assert.equal(imageUrl('/thumbs/封面 #1%.png', 'https://img.example.test/public/'), 'https://img.example.test/public/thumbs/%E5%B0%81%E9%9D%A2%20%231%25.png');
  assert.equal(imageUrl('/thumbs/a%20b.png'), '/thumbs/a%20b.png');
  assert.equal(audioUrl('songs/a%20b.mp3', ''), '/audio/songs/a%2520b.mp3');
  assert.equal(imageUrl('thumbs/a.png', ''), '/thumbs/a.png');
  assert.equal(imageUrl('', 'https://img.example.test'), '');
});

test('unsupported addresses and traversal cannot become media requests', () => {
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,a', 'file:///C:/a.mp3', 'ftp://host/a', '//host/a', 'https://host\\a', 'https://user:pass@host/a', 'https://', '../a', 'thumbs/../a', 'https://host/\na']) {
    assert.equal(audioUrl(value, ''), '');
    assert.equal(imageUrl(value, ''), '');
    assert.equal(isRemoteMediaUrl(value), false);
  }
  assert.equal(imageUrl('thumbs/%2e%2e/a.png'), '');
});

test('invalid base configuration fails instead of sending requests to an unintended path', () => {
  assert.equal(normalizeMediaBaseUrl(' https://cdn.example.test/audio/// '), 'https://cdn.example.test/audio');
  for (const value of ['//host/audio', '/audio', 'https://host/audio?token=secret', 'https://host/audio#hash', 'https://user:pass@host/audio', 'javascript:alert(1)']) {
    assert.throws(() => normalizeMediaBaseUrl(value));
  }
});

test('the player uses remote URLs unchanged and reports invalid media without creating audio', () => {
  const urls = [];
  const errors = [];
  const player = createAudioPlayer(() => {}, (error) => errors.push(error), (url) => {
    urls.push(url);
    const audio = new EventTarget();
    audio.play = () => Promise.resolve();
    audio.pause = () => {};
    audio.removeAttribute = () => {};
    audio.load = () => {};
    return audio;
  });
  const url = 'https://bucket.example.test/a.mp3?Signature=A%2Fb%2B&Expires=123';
  player.play({ path: url, zh: 'Remote' }, 'group');
  assert.deepEqual(urls, [url]);
  player.play({ path: 'javascript:alert(1)', zh: 'Invalid' }, 'group');
  assert.equal(urls.length, 1);
  assert.equal(errors.length, 1);
  player.stop();
});
