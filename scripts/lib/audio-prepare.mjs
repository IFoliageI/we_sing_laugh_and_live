import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

/** 原始帧不变，只按 FFprobe 的帧位置补齐 FLAC SEEKTABLE。 */
export function indexedFlacHeader(header, packets) {
  if (header.toString('ascii', 0, 4) !== 'fLaC') throw new Error('输入不是原生 FLAC。');
  const blocks = [];
  let offset = 4;
  let last = false;
  while (!last) {
    if (offset + 4 > header.length) throw new Error('FLAC 元数据不完整。');
    const tag = header[offset];
    const length = header.readUIntBE(offset + 1, 3);
    if (offset + 4 + length > header.length) throw new Error('FLAC 元数据不完整。');
    last = !!(tag & 0x80);
    const type = tag & 0x7f;
    if (blocks.length === 0 && (type !== 0 || length !== 34)) throw new Error('FLAC 缺少 STREAMINFO。');
    if (type !== 3) blocks.push({ type, data: header.subarray(offset + 4, offset + 4 + length) });
    offset += length + 4;
  }
  const points = packets.map((packet) => ({
    sample: BigInt(packet.pts), position: BigInt(packet.pos) - BigInt(offset), count: Number(packet.duration),
  }));
  if (!points.length || points[0].sample !== 0n || points[0].position !== 0n) throw new Error('无法确认 FLAC 第一帧位置。');
  for (const [index, point] of points.entries()) {
    if (point.sample < 0n || point.position < 0n || !Number.isInteger(point.count) || point.count <= 0 || point.count > 65535
      || (index > 0 && (point.sample <= points[index - 1].sample || point.position <= points[index - 1].position))) {
      throw new Error('FLAC 帧索引无效。');
    }
  }
  const seek = Buffer.alloc(points.length * 18);
  if (seek.length > 0xffffff) throw new Error('FLAC 索引超出元数据块大小。');
  for (const [index, point] of points.entries()) {
    seek.writeBigUInt64BE(point.sample, index * 18);
    seek.writeBigUInt64BE(point.position, index * 18 + 8);
    seek.writeUInt16BE(point.count, index * 18 + 16);
  }
  blocks.splice(1, 0, { type: 3, data: seek });
  const encoded = blocks.map((block, index) => {
    const prefix = Buffer.alloc(4);
    prefix[0] = block.type | (index === blocks.length - 1 ? 0x80 : 0);
    prefix.writeUIntBE(block.data.length, 1, 3);
    return Buffer.concat([prefix, block.data]);
  });
  return { header: Buffer.concat([Buffer.from('fLaC'), ...encoded]), audioOffset: offset, seekPoints: points.length };
}

export async function prepareAudio({ input, output, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' }) {
  const source = path.resolve(input);
  const target = path.resolve(output);
  if (source.toLowerCase() === target.toLowerCase() || fs.existsSync(target)) throw new Error('输出必须是尚不存在的新文件，原始音频不会覆盖。');
  const extension = path.extname(source).toLowerCase();
  const expected = extension === '.aac' ? '.m4a' : extension === '.flac' ? '.flac' : null;
  if (!expected || path.extname(target).toLowerCase() !== expected) throw new Error('仅支持 .aac → 新的 .m4a，或 .flac → 新的 .flac。');
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,time_base', '-of', 'json', source,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  if (probe.streams?.[0]?.codec_name !== (extension === '.aac' ? 'aac' : 'flac')) throw new Error('实际编码与文件扩展名不一致。');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${randomUUID()}${expected}`);
  let result;
  try {
    if (extension === '.aac') {
      execFileSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source,
        '-map', '0:a:0', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', temporary,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      result = { operation: 'AAC 原编码封装为 M4A，无重编码' };
    } else {
      const stream = probe.streams[0];
      if (stream.time_base !== `1/${stream.sample_rate}`) throw new Error('FLAC 时间基准不支持。');
      const { packets } = JSON.parse(execFileSync(ffprobe, [
        '-v', 'error', '-select_streams', 'a:0', '-show_packets',
        '-show_entries', 'packet=pts,pos,duration', '-of', 'json', source,
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      const handle = await fs.promises.open(source, 'r');
      let header;
      try {
        const length = Number(packets?.[0]?.pos);
        if (!Number.isSafeInteger(length) || length < 42 || length > 64 * 1024 * 1024) throw new Error('FLAC 元数据长度无效。');
        header = Buffer.alloc(length);
        const { bytesRead } = await handle.read(header, 0, length, 0);
        if (bytesRead !== length) throw new Error('FLAC 元数据读取不完整。');
      } finally { await handle.close(); }
      const indexed = indexedFlacHeader(header, packets);
      await fs.promises.writeFile(temporary, indexed.header, { flag: 'wx' });
      await pipeline(fs.createReadStream(source, { start: indexed.audioOffset }), fs.createWriteStream(temporary, { flags: 'a' }));
      result = { operation: 'FLAC 补齐逐帧 SEEKTABLE，原始音频帧不变', seekPoints: indexed.seekPoints };
    }
    // 不覆盖先前存在或在转换期间新建的目标文件。
    await fs.promises.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
    return { input: source, output: target, ...result };
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}
