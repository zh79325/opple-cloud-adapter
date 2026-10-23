// opple Web 站点后端：零依赖 Node 服务，复用 OppleClient
// 提供 REST API + MCP 端点（含公网隧道）+ 托管 ice 前端构建产物（web/build）
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { OppleClient } from './client.js';
import { handleMcpRequest } from './mcp.js';

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

// ---- MCP 公网隧道（Cloudflare quick tunnel）----
// 手机端 AI 运行在云端机房，无法访问局域网地址；server 启动后自动拉起 cloudflared，
// 把本机 MCP 端点映射成公网 HTTPS URL（每次启动域名随机变化，前端经 /api/mcp-info 实时回读）。
// MCP_TUNNEL=off 可关闭；懒启动设计保证被 ice dev server 导入时无副作用。
const MCP_KEY_DEFAULT = 'opple-25f372c8';
function mcpKey() {
  process.env.MCP_KEY ||= MCP_KEY_DEFAULT;
  return process.env.MCP_KEY;
}

const tunnel = { proc: null, url: null, error: null, errorAt: 0, starting: null };

function ensureTunnel() {
  if (process.env.MCP_TUNNEL === 'off') return Promise.resolve(null);
  if (tunnel.url) return Promise.resolve(tunnel.url);
  // 失败后 60 秒内不重复拉起（避免并发请求反复 spawn），超时后允许重试
  if (tunnel.error && Date.now() - tunnel.errorAt < 60000) return Promise.resolve(null);
  if (tunnel.starting) return tunnel.starting;
  tunnel.starting = (async () => {
    try {
      tunnel.error = null;
      // --protocol http2：国内家宽对 QUIC(UDP 7844) 干扰严重，退化到 TCP 443 握手边缘
      const proc = spawn('cloudflared', ['tunnel', '--protocol', 'http2', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      tunnel.proc = proc;
      const logs = []; // 保留输出尾部，失败时把真实原因带进面板
      const onData = (buf) => {
        for (const line of String(buf).split('\n').filter(Boolean)) {
          logs.push(line);
          if (logs.length > 40) logs.shift();
        }
        const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { tunnel.url = m[0]; tunnel.readyResolver?.(); }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => { // 命令不存在等（ENOENT）：spawn 异步报错，不监听会让 promise 悬挂到超时
        tunnel.error = `cloudflared 启动失败: ${e.message}`;
        tunnel.errorAt = Date.now();
      });
      proc.on('exit', (code) => {
        if (tunnel.url) {
          // 运行中断线：清除旧地址触发后续请求重连；立即允许重试
          tunnel.url = null;
          tunnel.error = '隧道中断，正在重试';
          tunnel.errorAt = Date.now() - 61000;
          tunnel.readyResolver?.();
        } else {
          const tail = logs.slice(-3).join(' ｜ ') || '（无输出）';
          tunnel.error = `提前退出(code ${code})：${tail}`;
          tunnel.errorAt = Date.now();
          tunnel.readyResolver?.(new Error(tunnel.error));
        }
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('30 秒内未就绪')), 30000);
        tunnel.readyResolver = (err) => { clearTimeout(timer); err ? reject(err) : resolve(); };
      });
    } catch (e) {
      tunnel.error = e.message;
      tunnel.errorAt = Date.now();
    } finally {
      tunnel.starting = null;
    }
    return tunnel.url;
  })();
  return tunnel.starting;
}

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

/** 生成发给手机端 AI 的完整绑定话术（地址动态注入；隧道域名变化后重新复制即可） */
function buildMcpScript(publicMcpUrl, lanMcpUrl) {
  return `你是我们家的灯光管家。我家中有一个灯光控制 MCP 服务器（欧享家/欧普智能家居），请按以下说明自行接入，之后我会用自然语言让你控灯。

【接入信息】
- 端点（优先公网）: ${publicMcpUrl}
- 备用（手机与 Mac 同 Wi-Fi 时）: ${lanMcpUrl}
- 协议：JSON-RPC 2.0 over HTTP POST，Content-Type: application/json
- 握手：先 POST {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"lamp-agent","version":"1.0"}}}，保留响应头 Mcp-Session-Id，后续每次请求带上
- 工具清单：POST {"jsonrpc":"2.0","id":2,"method":"tools/list"}
- 调用工具：POST {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"工具名","arguments":{…}}}；结果在 result.content[0].text

【可用工具 8 个】
1. list_devices  全屋设备清单（名称/vDeviceId/房间/在线）
2. light_control 开关与调光。device=中文名（如「客厅灯」）或 vDeviceId；action=on/off/bright/cct/color/daylight/duv；value 如 80（亮度%）、4000（色温K）、桃林红 / #FF8800（颜色）
3. light_status  读灯的实时状态
4. light_effect  灯带灯效：流水/跑马/呼吸/律动/静态色温渐变/动态色温渐变；可选 colors（逗号分隔颜色名，最多6色）、speed（1-100）、direction（0/1）、loop（0/1）
5. sync_strips   客厅双灯带无缝同步，参数同灯效，另支持 v=物理流速（米/秒）
6. sky_mode      天境灯天际模式，mode 1-15（1晨光/2晴空/4雨后彩虹/5暮霞/15郁金香）
7. theme_scene   节日主题（sceneNo 如 100041）或房间模板（templateId）
8. call_raw      底层命令透传（msgType+values），未经我同意不要使用

【工作约定】
- 不确定设备名时先调 list_devices，不要猜
- 调用失败时把返回的「执行失败」原文告诉我，禁止编造成功
- 「全屋」「所有灯」这类大范围操作，先跟我确认再执行
- 成功后一句话确认即可，不要贴原始 JSON
- 若端点连不上（可能我重启过服务、地址已变），直接告诉我，我会发新地址给你

现在请先调用 list_devices 熟悉我家设备，完成后告诉我你看到了哪些灯，然后等我指令。`;
}

/** 请求处理：API 路由 + 静态托管。独立服务（npm run web）与 ice dev server 内嵌模式共用 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ---- CORS（ice dev 模式 5173 端口跨域）----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ---- MCP 端点（手机端 AI 助手经公网隧道/局域网接入；dev 模式由 ice 中间件一并放行） ----
  if (path === '/mcp') {
    mcpKey(); // 确保鉴权口令 env 就位（handleMcpRequest 读取 MCP_KEY）
    return handleMcpRequest(req, res);
  }

  // ---- API 路由 ----
  if (path.startsWith('/api/')) {
    try {
      // MCP 绑定信息：公网隧道地址（每次启动会变）+ 局域网地址 + 完整绑定话术。
      // 隧道在后台拉起、本接口绝不阻塞（隧道就绪可能要数秒甚至失败重试），
      // 返回 tunnelStarting=true 时前端稍后轮询「刷新地址」即可。
      if (req.method === 'GET' && path === '/api/mcp-info') {
        ensureTunnel().catch(() => {});
        const key = mcpKey();
        const lanMcpUrl = `http://${lanIp()}:${PORT}/mcp?key=${key}`;
        const publicMcpUrl = tunnel.url ? `${tunnel.url}/mcp?key=${key}` : null;
        return json(res, 200, {
          tunnelUrl: tunnel.url,
          tunnelStarting: !tunnel.url && !tunnel.error && Boolean(tunnel.starting),
          tunnelError: tunnel.error,
          publicMcpUrl,
          lanMcpUrl,
          script: buildMcpScript(publicMcpUrl ?? lanMcpUrl, lanMcpUrl),
        });
      }
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
}

// 仅直接运行本文件时启动独立 HTTP 服务（npm run web 生产托管模式）；
// 开发模式由 ice dev server 内嵌 handleRequest（见 web/ice.config.mts），不重复监听端口
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createServer((req, res) => handleRequest(req, res)).listen(PORT, () => {
    console.log(`opple web 已启动: http://localhost:${PORT}`);
    console.log(existsSync(join(WEB_DIST, 'index.html')) ? '前端已就绪' : '（前端未构建，仅 API 模式）');
    // 随服务拉起公网隧道（手机云端 AI 接入 MCP 用）；MCP_TUNNEL=off 关闭
    ensureTunnel().then((u) => {
      if (process.env.MCP_TUNNEL === 'off') return console.log('MCP 公网隧道已关闭（MCP_TUNNEL=off）');
      if (u) console.log(`MCP 公网隧道: ${u}/mcp?key=${mcpKey()}`);
      else console.log(`MCP 公网隧道未建立: ${tunnel.error ?? '未知原因'}（不影响局域网使用）`);
    });
  });
}
