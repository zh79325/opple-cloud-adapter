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
// 家庭/房间/设备结构本地快照（"同步数据"写入）：{ syncedAt, tree }，避免每次都请求欧享家云端
const TREE_FILE = join(__dirname, '../../data/local-tree.json');

function loadTreeCache() {
  try {
    const raw = JSON.parse(readFileSync(TREE_FILE, 'utf8'));
    if (Array.isArray(raw?.tree)) return raw;
  } catch { /* 快照不存在或损坏，视为无缓存 */ }
  return null;
}

function saveTreeCache(tree) {
  const payload = { syncedAt: new Date().toISOString(), tree };
  writeFileSync(TREE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

function loadPositions() {
  try { return JSON.parse(readFileSync(POS_FILE, 'utf8')); } catch { return {}; }
}

function savePositions(data) {
  writeFileSync(POS_FILE, JSON.stringify(data, null, 2));
}

/** 读房间数据：{ shape, devices, excluded }（excluded 为手动排除出空间模型的设备 id 列表） */
function readRoom(pos, projectCode, gpno) {
  const roomRaw = pos[projectCode]?.[String(gpno)];
  if (!roomRaw) return { shape: null, devices: {}, excluded: [] };
  return {
    shape: roomRaw.shape ?? null,
    devices: roomRaw.devices ?? {},
    excluded: Array.isArray(roomRaw.excluded) ? roomRaw.excluded : [],
  };
}

/** 写入房间数据（保持新格式） */
function writeRoom(all, projectCode, gpno, shape, devices, excluded) {
  all[projectCode] ??= {};
  all[projectCode][String(gpno)] = { shape, devices, excluded: excluded ?? [] };
}

/** 给 tree 结果注入设备位置与房间尺寸（仅灯具需要位置：灯=circle、灯带=segment；网关等点位不参与空间模型） */
function treeWithPositions(tree) {
  const pos = loadPositions();
  for (const home of tree) {
    for (const room of home.rooms) {
      const { shape, devices, excluded } = readRoom(pos, home.projectCode, room.gpno);
      room.shape = shape ?? { w: 100, h: 45, depth: 100 }; // 默认：宽:高:深 = 100:45:100
      for (const d of room.devices) {
        const p = devices[d.vDeviceId] ?? null;
        d.position = p && p.kind !== 'point' ? p : null;
        d.excluded = excluded.includes(d.vDeviceId);
      }
    }
  }
  return tree;
}

/** 剔除不参与空间模型的设备：point 类历史残留 + 手动排除；导出仅含参与布局的灯/灯带 */
function stripPoints(rooms) {
  const out = {};
  for (const [gpno, room] of Object.entries(rooms)) {
    const excluded = Array.isArray(room?.excluded) ? room.excluded : [];
    const devices = {};
    for (const [id, p] of Object.entries(room?.devices ?? {})) {
      if (p?.kind !== 'point' && !excluded.includes(id)) devices[id] = p;
    }
    out[gpno] = { shape: room?.shape, devices };
  }
  return out;
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
      // 三层结构：本地快照优先（零云端请求），无快照时回源拉取并落盘。
      // 返回 { source: 'local'|'remote', syncedAt, tree }；位置数据始终实时合并，不受快照影响。
      if (req.method === 'GET' && path === '/api/tree') {
        const cache = loadTreeCache();
        if (cache) {
          return json(res, 200, { source: 'local', syncedAt: cache.syncedAt, tree: treeWithPositions(cache.tree) });
        }
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        const tree = await client.tree();
        const saved = saveTreeCache(tree);
        return json(res, 200, { source: 'remote', syncedAt: saved.syncedAt, tree: treeWithPositions(tree) });
      }
      // 一键同步：拉取欧享家云端最新家庭/房间/设备结构，写入本地快照
      if (req.method === 'POST' && path === '/api/sync') {
        let client;
        try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
        const tree = await client.tree();
        const saved = saveTreeCache(tree);
        return json(res, 200, { ok: true, syncedAt: saved.syncedAt, tree: treeWithPositions(tree) });
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
      // 保存房间布局（编辑器保存位置/尺寸，或清单切换排除）
      // body: { projectCode, gpno, shape?, positions?, excluded? }
      // shape={w,h,depth} 房间尺寸；positions={vDeviceId: pos}；excluded=[vDeviceId] 手动排除出空间模型
      if (req.method === 'POST' && path === '/api/positions') {
        const { projectCode, gpno, shape, positions, excluded } = await readBody(req);
        if (!projectCode || !gpno) {
          return json(res, 400, { error: 'projectCode, gpno required' });
        }
        const all = loadPositions();
        const prev = readRoom(all, projectCode, gpno);
        writeRoom(
          all,
          projectCode,
          gpno,
          shape ?? prev.shape,
          positions && typeof positions === 'object' ? positions : prev.devices,
          Array.isArray(excluded) ? excluded : prev.excluded,
        );
        savePositions(all);
        return json(res, 200, { ok: true, saved: positions ? Object.keys(positions).length : 0 });
      }
      // 导出某家庭的结构化位置数据（供 AI 理解设备空间关系；仅灯/灯带）
      if (req.method === 'GET' && path === '/api/positions') {
        const pc = url.searchParams.get('projectCode');
        const all = loadPositions();
        if (pc) return json(res, 200, stripPoints(all[pc] ?? {}));
        const cleaned = {};
        for (const [pcode, rooms] of Object.entries(all)) cleaned[pcode] = stripPoints(rooms);
        return json(res, 200, cleaned);
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
  console.log(existsSync(join(WEB_DIST, 'index.html')) ? '前端已就绪' : '（前端未构建，仅 API 模式）');
});
