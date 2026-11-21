import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const host = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 3070);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

async function serve(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return reply(response, 405, 'Method not allowed');
  }
  let path;
  try {
    path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  } catch {
    return reply(response, 400, 'Invalid URL');
  }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) return reply(response, 403, 'Forbidden');

  try {
    const info = await stat(file);
    if (!info.isFile()) return reply(response, 404, 'File not found');
    const tag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    response.setHeader('ETag', tag);
    response.setHeader('Cache-Control', 'no-cache');
    if (request.headers['if-none-match'] === tag) {
      response.writeHead(304).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return response.end();
    await pipeline(createReadStream(file), response);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return reply(response, 404, 'File not found');
    console.error(error.message);
    reply(response, 500, 'Unable to read the file');
  }
}

try {
  await Promise.all(['viewer.js', 'models/monument/s3dgs.json', 'models/aula/s3dgs.json'].map(file => access(resolve(root, file))));
} catch (error) {
  console.error(`缺少运行资源：${error.path}。请完整解压交付包。`);
  process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须是 1–65535 之间的整数。');
  process.exit(1);
}

function viewerUrl(address) {
  const hostname = address.includes(':') ? `[${address}]` : address;
  return `http://${hostname}:${port}/`;
}

createServer(serve).on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可通过 PORT 环境变量指定其他端口。` : error.message);
  process.exitCode = 1;
}).listen(port, host, () => {
  console.log('3D Building Viewer');
  if (host !== '0.0.0.0' && host !== '::') {
    console.log(`  ${viewerUrl(host)}`);
    return;
  }

  console.log(`  Local: ${viewerUrl(host === '::' ? '::1' : '127.0.0.1')}`);
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const { family, address, internal } of addresses) {
      if (family === 'IPv4' && !internal) console.log(`  Network (${name}): ${viewerUrl(address)}`);
    }
  }
});
