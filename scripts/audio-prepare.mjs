import { parseArgs } from 'node:util';
import { prepareAudio } from './lib/audio-prepare.mjs';

try {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' }, output: { type: 'string' },
      ffmpeg: { type: 'string', default: process.env.FFMPEG_PATH || 'ffmpeg' },
      ffprobe: { type: 'string', default: process.env.FFPROBE_PATH || 'ffprobe' },
    },
  });
  if (!values.input || !values.output) throw new Error('用法：pnpm audio:prepare --input 原音频.aac --output 新音频.m4a；也支持 FLAC → 带索引的新 FLAC。');
  console.log(JSON.stringify(await prepareAudio(values), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
