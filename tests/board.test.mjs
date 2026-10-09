import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSongsByArtist, findVoice, audioUrl, shareUrl } from '../src/lib/board-data.ts';
import { createAudioPlayer } from '../src/lib/audio-player.ts';

const voice = { path: 'songs/a.mp3', zh: 'Song', artist: 'Artist' };

test('artist grouping includes collection members and deduplicates cross-category paths', () => {
  const groups = [
    { groupName: 'a', title: 'A', voices: [voice], stacks: [{ voices: [{ path: 'songs/b.mp3', zh: 'B', artist: ' Artist ' }] }] },
    { groupName: 'b', title: 'B', voices: [voice, { path: 'songs/c.mp3', zh: 'C' }], hiddenVoices: [{ path: 'secret.mp3', zh: 'Secret' }] },
  ];
  const result = groupSongsByArtist(groups);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].voices.map((item) => item.path), ['songs/a.mp3', 'songs/b.mp3']);
  assert.equal(result[1].title, '未知作者');
  assert.equal(findVoice(groups, 'songs/b.mp3').groupName, 'a');
  assert.equal(findVoice(groups, 'secret.mp3'), null);
  assert.equal(groupSongsByArtist(groups.slice(1))[0].groupName, result[0].groupName);
});

test('song share links retain the page route and encode names safely', () => {
  const url = new URL(shareUrl('https://example.test/request/?old=1#group-a', { path: 'songs/曲 #1%.mp3', zh: '曲 & Name' }));
  assert.equal(url.pathname, '/request/');
  assert.equal(url.searchParams.get('btn'), 'songs/曲 #1%.mp3');
  assert.equal(url.searchParams.get('name'), '曲 & Name');
  assert.equal(url.searchParams.has('old'), false);
  assert.equal(url.hash, '');
  assert.equal(audioUrl('songs/曲 #1%.mp3'), '/audio/songs/%E6%9B%B2%20%231%25.mp3');
});

class FakeAudio extends EventTarget {
  paused = true;
  duration = 10;
  currentTime = 0;
  loop = false;
  failure = null;
  sourceRemoved = false;
  play() {
    if (this.failure) return Promise.reject(this.failure);
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  removeAttribute() { this.sourceRemoved = true; }
  load() {}
}

function playerFixture() {
  let state = null;
  const errors = [];
  const audios = [];
  const player = createAudioPlayer(
    (next) => { state = next; },
    (message) => errors.push(message),
    () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
  );
  return { player, errors, audios, state: () => state };
}

test('media updates continue after the first state snapshot', () => {
  const { player, audios, state } = playerFixture();
  player.play(voice, 'songs');
  const audio = audios[0];
  assert.equal(state().isPlaying, true);
  for (const seconds of [2, 4, 6]) {
    audio.currentTime = seconds;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(state().progress, seconds * 10);
  }
  player.toggle();
  assert.equal(state().isPlaying, false);
  player.toggle();
  assert.equal(state().isPlaying, true);
  player.setLoop(true);
  assert.equal(audio.loop, true);
  player.stop();
  assert.equal(state(), null);
  assert.equal(audio.sourceRemoved, true);
});

test('stale events cannot stop or modify the newly playing audio', () => {
  const { player, audios, state, errors } = playerFixture();
  player.play(voice, 'songs');
  player.play({ path: 'songs/another.mp3', zh: 'Song' }, 'other');
  for (const event of ['ended', 'error', 'pause', 'timeupdate']) audios[0].dispatchEvent(new Event(event));
  assert.equal(state().path, 'songs/another.mp3');
  assert.equal(state().isPlaying, true);
  assert.deepEqual(errors, []);
  assert.equal(audios[0].sourceRemoved, true);
  player.stop();
});

test('file errors clear playback, while autoplay denial allows a manual retry', async () => {
  let state;
  const errors = [];
  const audio = new FakeAudio();
  audio.failure = new DOMException('Blocked', 'NotAllowedError');
  const player = createAudioPlayer((next) => { state = next; }, (error) => errors.push(error), () => audio);
  player.play(voice, 'songs');
  await Promise.resolve();
  assert.equal(state.isPlaying, false);
  assert.equal(state.isLoading, false);
  assert.equal(errors.length, 1);
  audio.failure = null;
  player.toggle();
  assert.equal(state.isPlaying, true);
  audio.dispatchEvent(new Event('error'));
  assert.equal(state, null);
  assert.equal(errors.length, 2);
});

test('an old rejected play promise cannot report failure for a newer track', async () => {
  let rejectOld;
  let state;
  const errors = [];
  const oldAudio = new FakeAudio();
  oldAudio.play = () => new Promise((resolve, reject) => { rejectOld = reject; });
  const newAudio = new FakeAudio();
  let first = true;
  const player = createAudioPlayer((next) => { state = next; }, (error) => errors.push(error), () => {
    if (first) { first = false; return oldAudio; }
    return newAudio;
  });
  player.play(voice, 'a');
  player.play({ path: 'other.mp3', zh: 'Other' }, 'b');
  rejectOld(new Error('Late failure'));
  await Promise.resolve();
  assert.equal(state.path, 'other.mp3');
  assert.equal(errors.length, 0);
  player.stop();
});

test('progress never becomes NaN or exceeds its bounds', () => {
  const { player, audios, state } = playerFixture();
  player.play(voice, 'songs');
  audios[0].duration = Infinity;
  audios[0].dispatchEvent(new Event('timeupdate'));
  assert.equal(state().progress, 0);
  audios[0].duration = 10;
  audios[0].currentTime = 12;
  audios[0].dispatchEvent(new Event('timeupdate'));
  assert.equal(state().progress, 100);
  audios[0].dispatchEvent(new Event('ended'));
  assert.equal(state(), null);
});
