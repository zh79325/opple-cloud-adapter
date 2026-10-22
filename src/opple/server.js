// opple Web 站点后端：零依赖 Node 服务，复用 OppleClient
// 提供 REST API + 托管 ice 前端构建产物（web/build）
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OppleClient } from './client.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 5170);
const WEB_DIST = join(__dirname, '../../web/build');
// 设备位置存储：projectCode -> gpno -> { shape: {w,h,depth}, devices: { vDeviceId -> position } }
// 位置坐标为房间平面百分比 (0-100)；elev 为离地高度百分比（0=地面，100=天花）
const POS_FILE = join(__dirname, '../../data/device-positions.json');

function loadPositions() {
  try { return JSON.parse(readFileSync(POS_FILE, 'utf8')); } catch { return {}; }
}

function savePositions(data) {
  writeFileSync(POS_FILE, JSON.stringify(data, null, 2));
}

/** 读房间数据：{ shape, devices } */
function readRoom(pos, projectCode, gpno) {
  const roomRaw = pos[projectCode]?.[String(gpno)];
  if (!roomRaw) return { shape: null, devices: {} };
  return { shape: roomRaw.shape ?? null, devices: roomRaw.devices ?? {} };
}

/** 写入房间数据（保持新格式） */
function writeRoom(all, projectCode, gpno, shape, devices) {
  all[projectCode] ??= {};
  all[projectCode][String(gpno)] = { shape, devices };
}

/** 给 tree 结果注入设备位置与房间尺寸 */
function treeWithPositions(tree) {
  const pos = loadPositions();
  for (const home of tree) {
    for (const room of home.rooms) {
      const { shape, devices } = readRoom(pos, home.projectCode, room.gpno);
      room.shape = shape ?? { w: 100, h: 45, depth: 100 }; // 默认：宽:高:深 = 100:45:100
      for (const d of room.devices) {
        d.position = devices[d.vDeviceId] ?? null;
      }
    }
  }
  return tree;
}

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

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
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
    try {
      if (req.method === 'GET' && path === '/api/homes') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        return json(res, 200, await client.homeList());
      }
      if (req.method === 'GET' && path === '/api/tree') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        const tree = await client.tree();
        return json(res, 200, treeWithPositions(tree));
      }
      if (req.method === 'GET' && path === '/api/devices') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        const gpNo = url.searchParams.get('gpNo');
        return json(res, 200, gpNo ? await client.roomDevices(gpNo) : await client.listDevices());
      }
      if (req.method === 'GET' && path === '/api/summary') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        return json(res, 200, await client.deviceSummary());
      }
      if (req.method === 'GET' && path === '/api/actions') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        const vid = url.searchParams.get('vDeviceId');
        if (!vid) return json(res, 400, { error: 'vDeviceId required' });
        return json(res, 200, await client.actionAbility(vid));
      }
      // 保存房间内设备位置（拖拽后调用）
      // body: { projectCode, gpno, positions: { vDeviceId: { x, y, name } } }
      if (req.method === 'POST' && path === '/api/positions') {
        // body: { projectCode, gpno, shape?, positions }（shape={w,h,depth} 房间尺寸，可选）
        const { projectCode, gpno, shape, positions } = await readBody(req);
        if (!projectCode || !gpno || typeof positions !== 'object') {
          return json(res, 400, { error: 'projectCode, gpno, positions required' });
        }
        const all = loadPositions();
        const prev = readRoom(all, projectCode, gpno);
        writeRoom(all, projectCode, gpno, shape ?? prev.shape, positions);
        savePositions(all);
        return json(res, 200, { ok: true, saved: Object.keys(positions).length });
      }
      // 导出某家庭的结构化位置数据（供 AI 理解设备空间关系）
      if (req.method === 'GET' && path === '/api/positions') {
        const pc = url.searchParams.get('projectCode');
        const all = loadPositions();
        if (pc) return json(res, 200, all[pc] ?? {});
        return json(res, 200, all);
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
