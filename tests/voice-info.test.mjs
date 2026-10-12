import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/lib/voice-info.ts';

test('duration formatting handles zero, fractions, minutes and hours', () => {
  for (const [seconds, label] of [
    [0, '0:00'], [0.8, '0:00'], [12.5, '0:12'], [59.9, '0:59'],
    [60, '1:00'], [125, '2:05'], [3600, '1:00:00'], [3665.9, '1:01:05'],
  ]) assert.equal(formatDuration(seconds), label);
});

test('missing or invalid duration metadata is hidden', () => {
  for (const seconds of [undefined, null, '', '12', -1, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(formatDuration(seconds), '');
  }
});
