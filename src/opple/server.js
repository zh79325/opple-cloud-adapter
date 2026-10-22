// opple Web 站点后端：零依赖 Node 服务，复用 OppleClient
// 提供 REST API + 托管 ice 前端构建产物（web/build）
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OppleClient } from './client.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 5170);
const WEB_DIST = join(__dirname, '../../web/build');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ---- CORS（ice dev 模式 5173 端口跨域）----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ---- API 路由 ----
  if (path.startsWith('/api/')) {
    let client;
    try { client = OppleClient.loadConfig(); }
    catch (e) { return json(res, 500, { error: e.message }); }

    try {
      if (req.method === 'GET' && path === '/api/homes') {
        return json(res, 200, await client.homeList());
      }
      if (req.method === 'GET' && path === '/api/tree') {
        return json(res, 200, await client.tree());
      }
      if (req.method === 'GET' && path === '/api/devices') {
        const gpNo = url.searchParams.get('gpNo');
        return json(res, 200, gpNo ? await client.roomDevices(gpNo) : await client.listDevices());
      }
      if (req.method === 'GET' && path === '/api/summary') {
        return json(res, 200, await client.deviceSummary());
      }
      if (req.method === 'GET' && path === '/api/actions') {
        const vid = url.searchParams.get('vDeviceId');
        if (!vid) return json(res, 400, { error: 'vDeviceId required' });
        return json(res, 200, await client.actionAbility(vid));
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // ---- 静态文件（托管 ice 构建产物）----
  if (req.method === 'GET') {
    let file = path === '/' ? '/index.html' : path;
    const full = join(WEB_DIST, file);
    if (existsSync(full)) {
      const ext = extname(full);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    // SPA 回退到 index.html
    const idx = join(WEB_DIST, 'index.html');
    if (existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(idx));
    }
    return json(res, 200, { name: 'opple web', hint: '前端未构建：cd web && npm i && npm run build' });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`opple web 已启动: http://localhost:${PORT}`);
  console.log(WEB_DIST.includes('dist') && existsSync(WEB_DIST) ? '前端已就绪' : '（前端未构建，仅 API 模式）');
});
