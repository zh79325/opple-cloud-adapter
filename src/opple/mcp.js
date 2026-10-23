/**
 * 欧享家 MCP 服务器 —— 把 CLI 的灯光控制能力暴露为 Model Context Protocol 工具，
 * 供手机端 AI 助手（千问/豆包等支持自定义 MCP 的客户端）通过局域网 HTTP 接入。
 *
 * 传输层：MCP Streamable HTTP（2025-03-26 规范核心子集），零依赖手写 JSON-RPC 2.0：
 *   POST /mcp  initialize / notifications/initialized / tools/list / tools/call / ping
 * 响应为单体 application/json（规范允许的非流式形态），支持 Mcp-Session-Id 回显与 CORS。
 *
 * 挂载：默认内嵌 —— server.js 的 handleRequest 与 ice dev 中间件（web/ice.config.mts，
 * 拦截 /api/* 与 /mcp）共用单进程；也可 `npm run mcp` 独立监听 5171。
 * 手机端配置（千问 App → MCP 工具 → 自定义）：
 *   dev 模式  { "mcpServers": { "opple": { "url": "http://192.168.0.139:3000/mcp" } } }
 *   web 托管  { "mcpServers": { "opple": { "url": "http://192.168.0.139:5170/mcp" } } }
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  getClient, LIGHT, COLORS, DAYLIGHT, SCENE, SYNC_STRIPS,
  resolveColor, buildEffectCmd, MARQUEE_PERIOD,
} from '../cli.js';

const PORT = Number(process.env.MCP_PORT ?? 5171);
const PROTOCOL_VERSION = '2025-03-26';
const sessions = new Set();

// ---------- 工具实现（复用 CLI 的下发语义与参数校验） ----------

let clientCache = null;
function client() {
  if (!clientCache) clientCache = getClient();
  return clientCache;
}

/** 设备名/ID → vDeviceId 模糊解析（精确 ID > 全名 > 包含；多命中报候选） */
async function resolveDevice(input) {
  const homes = await client().tree();
  const all = [];
  for (const home of homes) {
    for (const room of home.rooms) {
      for (const d of room.devices) {
        all.push({ ...d, homeName: home.name, roomName: room.name });
      }
    }
  }
  const hit = all.filter(d =>
    d.vDeviceId === String(input) || d.name === input);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new Error(`「${input}」匹配到多台设备: ${hit.map(d => `${d.name}(${d.vDeviceId})`).join('、')}`);
  const fuzzy = all.filter(d => d.name.includes(String(input)) || String(input).includes(d.name));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) throw new Error(`「${input}」模糊匹配到多台设备: ${fuzzy.map(d => `${d.name}(${d.vDeviceId})`).join('、')}，请用完整名称或 vDeviceId`);
  throw new Error(`找不到设备「${input}」，可用设备: ${all.map(d => `${d.name}(${d.vDeviceId})`).join('、')}`);
}

const KEY_STATUS = {
  '0x0207': '灯具开关(0/1)',
  '0x0208': '开关(0/1)',
  '0x0300': '亮度(0-255)',
  '0x0400': '色温(K)',
  '0x1E1D': 'DUV',
  '0x1A02': '灯具模式(0日光/1彩光/3天际/254主题光)',
  '0x1A03': '日光运行反馈',
  '0x1A04': '颜色CXCY',
  '0x140D': '天际槽A',
  '0x140F': '天际槽B',
  '0x1A10': '主题光场景号(100xxx,-2无)',
  '0x1E0D': '跑马参数',
  '0x1E0E': '跑马颜色',
  '0x1E0F': '跑马速度方向',
};

async function toolListDevices() {
  const homes = await client().tree();
  const out = [];
  for (const home of homes) {
    for (const room of home.rooms) {
      for (const d of room.devices) {
        out.push({ 名称: d.name, vDeviceId: d.vDeviceId, 房间: room.name, 在线: d.online ? 1 : 0, 品类: d.type ?? '', 协议: d.protocol ?? '' });
      }
    }
  }
  return { 设备数: out.length, 设备: out };
}

async function toolLightControl({ device, action, value }) {
  const d = await resolveDevice(device);
  const id = d.vDeviceId;
  let sent;
  switch (action) {
    case 'on': case 'off':
      sent = await client().callAction(id, LIGHT.switch, [action === 'on' ? 1 : 0]);
      break;
    case 'bright': {
      let v = value;
      if (String(v).endsWith('%')) v = Math.round(parseFloat(v) * 255 / 100);
      v = Number(v);
      if (!(v >= 1 && v <= 255)) throw new Error('亮度范围 1-255 或 1%-100%');
      sent = await client().callAction(id, LIGHT.bright, [v]);
      break;
    }
    case 'cct': {
      const v = Number(value);
      if (!(v >= 1800 && v <= 12000)) throw new Error('色温范围 1800-12000K');
      sent = await client().callAction(id, LIGHT.cct, [v]);
      break;
    }
    case 'duv': {
      const v = Number(value);
      if (!(v >= -8 && v <= 8)) throw new Error('DUV 范围 -8~8');
      sent = await client().callAction(id, LIGHT.duv, [0, v]);
      break;
    }
    case 'color':
      sent = await client().callAction(id, LIGHT.color, [0, resolveColor(String(value))]);
      break;
    case 'daylight': {
      const v = DAYLIGHT[value] ?? Number(value);
      if (v === undefined) throw new Error(`日光模式支持: ${Object.keys(DAYLIGHT).join('/')}`);
      sent = await client().callAction(id, '0x046F0000', [0, v]);
      break;
    }
    default:
      throw new Error(`未知动作: ${action}（支持 on/off/bright/cct/color/daylight/duv）`);
  }
  return { 结果: '已下发', 设备: d.name, vDeviceId: id, 动作: action, 参数: value ?? '', StatusCode: sent?.StatusCode ?? sent };
}

async function toolLightStatus({ device }) {
  const d = await resolveDevice(device);
  const { device: dev, status } = await client().deviceStatus(d.vDeviceId);
  const key = [];
  for (const s of status) {
    const name = KEY_STATUS[s.StatusType];
    if (!name) continue;
    let val = String(s.Value);
    if (s.StatusType === '0x0300') val += ` (${Math.round((Number(s.Value) / 255) * 100)}%)`;
    key.push({ 状态码: s.StatusType, 含义: name, 值: val, 更新: new Date(s.TimeStamp).toLocaleTimeString() });
  }
  return { 设备: dev.DeviceName, vDeviceId: d.vDeviceId, deviceId: dev.DeviceId, 关键状态: key };
}

async function toolLightEffect({ device, effect, colors, speed, direction, loop }) {
  const d = await resolveDevice(device);
  const sc = SCENE[effect];
  if (!sc) throw new Error(`未知效果: ${effect}，支持: ${Object.keys(SCENE).join('/')}`);
  const opt = { colors, speed, direction, loop };
  let msg = '0x14010000';
  let values = [0, sc.mode];
  if (sc.full && (colors || speed || direction !== undefined || loop !== undefined)) {
    ({ msg, values } = buildEffectCmd(effect, opt));
  }
  const sent = await client().callAction(d.vDeviceId, msg, values);
  return { 结果: '已下发', 设备: d.name, 灯效: effect, 命令: msg, values, StatusCode: sent?.StatusCode ?? sent };
}

async function toolSyncStrips({ effect, speed, v, colors, swap }) {
  if (!SCENE[effect]) throw new Error(`未知效果: ${effect}，支持: ${Object.keys(SCENE).join('/')}`);
  let sp = Math.min(100, Math.max(1, Number(speed) || SCENE[effect].defSpeed));
  let vNote = '';
  if (v !== undefined) {
    const vv = Number(v);
    if (!(vv > 0)) throw new Error('v 需为正数（米/秒）');
    sp = Math.min(100, Math.max(20, Math.round((16.40 - SYNC_STRIPS[0].len / vv) / 0.117)));
  }
  const strips = swap ? SYNC_STRIPS.map(s => ({ ...s, dir: s.dir === 0 ? 1 : 0 })) : SYNC_STRIPS;
  const opt = { colors };
  if (!colors) {
    const { status } = await client().deviceStatus(SYNC_STRIPS[0].id);
    const cur = status.find(s => s.StatusType === '0x1E0D');
    const hex = cur ? String(cur.Value).replace(/[^0-9a-fA-F]/g, '') : '';
    if (hex.length >= 16) opt.colors = (hex.match(/.{8}/g) ?? []).join(',');
  }
  const results = [];
  for (const st of strips) {
    const { msg, values } = buildEffectCmd(effect, { ...opt, speed: sp, direction: st.dir });
    await client().callAction(st.id, msg, values);
    results.push({ 灯带: st.name, vDeviceId: st.id, 方向: st.dir });
  }
  const extra = SCENE[effect].mode === 1
    ? { 跑马周期秒: +MARQUEE_PERIOD(sp).toFixed(2), 说明: vNote || `速度档 ${sp}` }
    : {};
  return { 结果: '双带已同步下发', 灯效: effect, 速度档: sp, 下发: results, ...extra };
}

const SKY = { 1: '晨光', 2: '晴空', 3: '蓝天白云', 4: '雨后彩虹', 5: '暮霞', 6: '春回大地', 7: '夏日风情', 8: '秋风落日', 9: '冬日飞雪', 10: '麦田丝柏树', 11: '绿色麦田', 12: '克林姆特花园', 13: '花田', 14: '莫奈海', 15: '郁金香' };

async function toolSkyMode({ device, mode }) {
  const d = await resolveDevice(device);
  const num = Number(mode);
  if (!(num >= 1 && num <= 15)) throw new Error(`天际模式号 1-15: ${JSON.stringify(SKY)}`);
  const sent = await client().callAction(d.vDeviceId, '0x14190000', [0, num]);
  return { 结果: '已下发', 设备: d.name, 天际模式: `${num}-${SKY[num]}`, StatusCode: sent?.StatusCode ?? sent };
}

/** 节日主题（/api/Scene/Call?sceneNo=100xxx）与房间场景模板（/api/Area/AdjustByTemplate） */
async function toolThemeScene({ sceneNo, templateId, gpNo }) {
  const c = client();
  if (sceneNo !== undefined) {
    const r = await c.get('/api/Scene/Call', { sceneNo });
    return { 结果: '主题已下发', 通道: 'Scene/Call', sceneNo, StatusCode: r?.StatusCode ?? r };
  }
  if (templateId !== undefined) {
    let g = gpNo;
    if (g === undefined) {
      const homes = await c.tree();
      g = homes[0]?.rooms?.[0]?.gpno;   // 缺省取第一个房间（客厅）
      if (g === undefined) throw new Error('需要 gpNo（房间号）');
    }
    const r = await c.get('/api/Area/AdjustByTemplate', { gpNo: g, templateId });
    return { 结果: '房间模板已下发', 通道: 'AdjustByTemplate', gpNo: g, templateId, StatusCode: r?.StatusCode ?? r };
  }
  throw new Error('需要 sceneNo（节日主题 100xxx）或 templateId（房间模板）');
}

async function toolCallRaw({ device, msgType, values }) {
  const d = await resolveDevice(device);
  const vals = String(values ?? '').split(',').filter(s => s !== '').map(v => /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  const sent = await client().callAction(d.vDeviceId, msgType, vals);
  return { 结果: '已下发', 设备: d.name, msgType, values: vals, StatusCode: sent?.StatusCode ?? sent };
}

// ---------- 工具定义（描述写给手机端 LLM 阅读） ----------

const TOOLS = [
  {
    name: 'list_devices',
    description: '列出家庭全部智能设备（名称、vDeviceId、房间、在线状态）。控制任何设备前若不确定 device 参数，先调用本工具。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'light_control',
    description: '控制一盏灯。action 可选：on 开 / off 关 / bright 亮度（1-255 或 1%-100%）/ cct 色温（1800-12000K，如 6500）/ color 颜色（预设中文名如 桃林红、#RRGGBB、或 cx,cy 坐标）/ daylight 日光模式（晨曦/旭日/沐阳/夕照/明月/静夜）/ duv。device 支持中文名称模糊匹配（如「客厅灯」）或 vDeviceId。',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: '设备中文名称或 vDeviceId，如 客厅灯 / 2122050' },
        action: { type: 'string', enum: ['on', 'off', 'bright', 'cct', 'color', 'daylight', 'duv'] },
        value: { type: 'string', description: '动作参数：bright=80、cct=4000、color=桃林红 等；on/off 无需参数' },
      },
      required: ['device', 'action'],
    },
  },
  {
    name: 'light_status',
    description: '读取灯的实时状态（开关/亮度/色温/灯具模式/主题场景号等关键状态码）。',
    inputSchema: { type: 'object', properties: { device: { type: 'string', description: '设备名称或 vDeviceId' } }, required: ['device'] },
  },
  {
    name: 'light_effect',
    description: '给灯带下发动态灯效。effect 可选：流水/跑马/呼吸/律动/静态色温渐变/动态色温渐变。colors 为逗号分隔颜色（预设名/#RRGGBB，最多 6 色）；speed 1-100；direction 0|1；loop 0|1。仅指定 effect 时沿用设备当前颜色与速度。',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: '灯带名称或 vDeviceId，如 电视机灯带 / 2122018' },
        effect: { type: 'string', enum: Object.keys(SCENE) },
        colors: { type: 'string', description: '如 桃林红,山海青' },
        speed: { type: 'number', description: '1-100' },
        direction: { type: 'number', description: '0 正向 / 1 反向' },
        loop: { type: 'number', description: '0 停 / 1 循环' },
      },
      required: ['device', 'effect'],
    },
  },
  {
    name: 'sync_strips',
    description: '客厅双灯带无缝同步（参数镜像+方向互补背靠背下发）。effect 同灯效枚举；speed 1-100 或 v 物理流速(米/秒, 0.69-2.07)；colors 缺省沿用当前配色；swap 交换方向兜底。',
    inputSchema: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: Object.keys(SCENE) },
        speed: { type: 'number' },
        v: { type: 'number', description: '物理流速米/秒' },
        colors: { type: 'string' },
        swap: { type: 'boolean' },
      },
      required: ['effect'],
    },
  },
  {
    name: 'sky_mode',
    description: '天境灯天际（自然光）模式 15 档：1晨光 2晴空 3蓝天白云 4雨后彩虹 5暮霞 6春回大地 7夏日风情 8秋风落日 9冬日飞雪 10麦田丝柏树 11绿色麦田 12克林姆特花园 13花田 14莫奈海 15郁金香。',
    inputSchema: {
      type: 'object',
      properties: { device: { type: 'string' }, mode: { type: 'number', description: '1-15' } },
      required: ['device', 'mode'],
    },
  },
  {
    name: 'theme_scene',
    description: '下发主题/场景：sceneNo 为节日主题号（100xxx 段，已知 100041、100056共筑国梦、100057）；或 templateId 为房间场景模板（26运动/27会客/28休闲/29观影，缺省 gpNo 取第一个房间）。',
    inputSchema: {
      type: 'object',
      properties: {
        sceneNo: { type: 'number', description: '节日主题号 100xxx' },
        templateId: { type: 'number', description: '房间模板 ID' },
        gpNo: { type: 'number', description: '房间号（templateId 时可选）' },
      },
    },
  },
  {
    name: 'call_raw',
    description: '高级：按能力表直接透传云端命令（callAction）。msgType 为十六进制命令字（如 0x03110000），values 为逗号分隔参数。',
    inputSchema: {
      type: 'object',
      properties: { device: { type: 'string' }, msgType: { type: 'string' }, values: { type: 'string', description: '如 0,6500' } },
      required: ['device', 'msgType'],
    },
  },
];

const HANDLERS = {
  list_devices: () => toolListDevices(),
  light_control: a => toolLightControl(a),
  light_status: a => toolLightStatus(a),
  light_effect: a => toolLightEffect(a),
  sync_strips: a => toolSyncStrips(a),
  sky_mode: a => toolSkyMode(a),
  theme_scene: a => toolThemeScene(a),
  call_raw: a => toolCallRaw(a),
};

// ---------- MCP JSON-RPC 分发 ----------

function jsonRpc(id, result) { return { jsonrpc: '2.0', id, result }; }
function jsonRpcErr(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleRpc(body) {
  const { id, method, params } = body;
  switch (method) {
    case 'initialize':
      return jsonRpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'opple-mcp', version: '0.1.0' },
      });
    case 'notifications/initialized':
      return null; // 通知无需响应
    case 'ping':
      return jsonRpc(id, {});
    case 'tools/list':
      return jsonRpc(id, { tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      const handler = HANDLERS[name];
      if (!handler) return jsonRpcErr(id, -32602, `未知工具: ${name}`);
      try {
        const out = await handler(args ?? {});
        return jsonRpc(id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (e) {
        return jsonRpc(id, {
          content: [{ type: 'text', text: `执行失败: ${e.message}` }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcErr(id ?? null, -32601, `未知方法: ${method}`);
  }
}

// ---------- HTTP 入口 ----------

/** 无副作用导出：供 server.js 的 handleRequest 与 ice dev 中间件内嵌挂载 */
export async function handleMcpRequest(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Authorization',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // 公网暴露时的口令校验：设置 MCP_KEY 环境变量即启用（本地模式不设置则放行）。
  // 支持两种携带方式：?key=xxx 或 Authorization: Bearer xxx（手机 MCP 配置若无自定义 header 就用 query）
  const secret = process.env.MCP_KEY;
  if (secret) {
    const url = new URL(req.url, 'http://x');
    const given = url.searchParams.get('key')
      ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (given !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
      return res.end(JSON.stringify(jsonRpcErr(null, -32001, 'unauthorized: key mismatch')));
    }
  }

  if (req.method === 'GET' && (req.url === '/mcp' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    return res.end(JSON.stringify({
      server: 'opple-mcp', version: '0.1.0', endpoint: '/mcp',
      tools: TOOLS.map(t => t.name),
      hint: 'POST JSON-RPC 2.0（initialize / tools/list / tools/call）',
    }, null, 2));
  }

  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
    res.writeHead(404, cors); return res.end('not found');
  }

  let raw = '';
  for await (const ch of req) raw += ch;
  let body;
  try { body = JSON.parse(raw); } catch { res.writeHead(400, cors); return res.end('bad json'); }

  try {
    const result = await handleRpc(body);
    if (result === null) { res.writeHead(202, cors); return res.end(); }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...cors };
    if (body.method === 'initialize') {
      const sid = `opple-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessions.add(sid);
      headers['Mcp-Session-Id'] = sid;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify(jsonRpcErr(body?.id ?? null, -32603, e.message)));
  }
}

// 仅直接运行本文件时启动独立 HTTP 服务（npm run mcp）；
// 默认形态由 server.js / ice dev 内嵌 handleMcpRequest，不重复监听端口
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createServer((req, res) => handleMcpRequest(req, res)).listen(PORT, '0.0.0.0', () => {
    const ip = process.env.MCP_ADVERTISE_IP ?? '192.168.0.139';
    console.log(`opple-mcp 独立模式已启动: http://${ip}:${PORT}/mcp`);
    console.log(`工具 (${TOOLS.length}): ${TOOLS.map(t => t.name).join(', ')}`);
    console.log('手机端配置（同 Wi-Fi）：MCP URL 填上面的地址');
  });
}
