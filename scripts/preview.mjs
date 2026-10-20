import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preview } from 'astro';
import config from '../astro.config.mjs';
import { publicMediaMiddleware } from './lib/public-media-plugin.mjs';

const args = process.argv.slice(2);
const hostIndex = args.indexOf('--host');
if (hostIndex >= 0 && (!args[hostIndex + 1] || args[hostIndex + 1].startsWith('--'))) args.splice(hostIndex + 1, 0, '0.0.0.0');
const { values } = parseArgs({
  args,
  options: { host: { type: 'string' }, port: { type: 'string' }, open: { type: 'boolean' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log('pnpm preview [--host [地址]] [--port 端口] [--open]');
} else {
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('端口必须是 0～65535 的整数。');
  const root = new URL('../', import.meta.url);
  const serverOptions = {};
  if (values.host !== undefined) serverOptions.host = values.host;
  if (port !== undefined) serverOptions.port = port;
  if (values.open) serverOptions.open = true;
  const app = await preview({ root: fileURLToPath(root), server: serverOptions });
  // Astro 的静态 preview 不加载用户 Vite 插件，在原有请求处理前加同一媒体处理器。
  const handlers = app.server.listeners('request');
  const middleware = publicMediaMiddleware(fileURLToPath(new URL(config.outDir ?? './dist/', root)), config.base ?? '/');
  app.server.removeAllListeners('request');
  app.server.on('request', (req, res) => {
    void middleware(req, res, () => {
      for (const handler of handlers) handler.call(app.server, req, res);
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.stop(); });
}
