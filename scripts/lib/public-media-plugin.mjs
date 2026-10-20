import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const mediaExtensions = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm', '.wma',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif',
]);

/** Vite 的静态处理会再次解码特殊文件名；在开发和预览中按原始文件名读取一次。 */
export function publicMediaMiddleware(directory, base = '/') {
  const root = path.resolve(directory);
  return async (req, res, next) => {
    const encoded = (req.url ?? '').split('?')[0];
    if (!['GET', 'HEAD'].includes(req.method) || !encoded.startsWith(base) || !/%(?:23|25|3f)/i.test(encoded)) return next();
    let decoded;
    try { decoded = decodeURIComponent(encoded.slice(base.length)); } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const parts = decoded.split('/');
    if (!['audio', 'thumbs'].includes(parts[0])) return next();
    if (parts.some((part) => !part || part === '.' || part === '..') || /[\\\u0000-\u001f]/.test(decoded)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!mediaExtensions.has(path.extname(decoded).toLowerCase())) return next();
    try {
      const file = await fs.promises.realpath(path.join(root, ...parts));
      const realRoot = await fs.promises.realpath(root);
      if (!file.startsWith(realRoot + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return next();
      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      res.setHeader('Accept-Ranges', 'bytes');
      const types = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
        '.webm': 'audio/webm', '.wma': 'audio/x-ms-wma', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
        '.avif': 'image/avif',
      };
      res.setHeader('Content-Type', types[path.extname(file).toLowerCase()]);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      let start = 0;
      let end = stat.size - 1;
      // 弱 ETag 不能满足 If-Range；该情况下返回完整对象。
      const rangeHeader = req.method === 'GET' && !req.headers['if-range'] ? req.headers.range : null;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
        }
        if (!match || (!match[1] && !match[2]) || (!match[1] && Number(match[2]) <= 0)
          || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      res.writeHead(rangeHeader ? 206 : 200);
      if (req.method === 'HEAD' || stat.size === 0) res.end();
      else await pipeline(fs.createReadStream(file, { start, end }), res);
    } catch (error) {
      if (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.destroyed) return;
      if (['ENOENT', 'ENOTDIR'].includes(error.code) && !res.headersSent) return next();
      if (!res.headersSent) { res.writeHead(500); res.end(); }
      else res.destroy(error);
    }
  };
}

export function publicMediaPlugin() {
  let config;
  return {
    name: 'local-public-media-filenames',
    configResolved(value) { config = value; },
    configureServer(server) {
      server.middlewares.use(publicMediaMiddleware(config.publicDir, config.base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(publicMediaMiddleware(path.resolve(config.root, config.build.outDir), config.base));
    },
  };
}
