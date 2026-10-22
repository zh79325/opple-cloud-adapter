// CLI 命令分发与实现
import { OppleClient } from './opple/client.js';

const HELP = `opple — 欧享家（欧普 INNO）本地终端控制

用法: opple <命令> [参数]

命令:
  token save <token> <projectCode>   保存凭据到 ~/.opple-cli.json
  token check                        校验/刷新 token
  homes                              家庭列表
  tree                               家庭 → 房间 → 设备 三层结构树
  devices [房间名|Gpno]              设备列表（可按房间过滤）
  actions <vDeviceId>                查询某设备全部可调用动作（含参数范围）
  light <id> <op> <值>               灯光控制
    op: on / off / bright(1-255或%) / cct(1800-12000K) / duv(-8~8)
        color(预设名|#RGB|cx,cy) / daylight(晨曦|旭日|沐阳|夕照|明月|静夜)
  scene <id> <效果> [k=v…]           灯效控制（跃动模式，灯带类设备）
    效果: 流水/跑马/呼吸/律动/静态色温渐变/动态色温渐变/静态颜色渐变
    参数: color= speed=(1-100) direction=(forward|reverse) loop=(0|1)
          cctFrom= cctTo= duration=(1-10)
  call <id> <msgType> <v1,v2,…>      底层命令调用（actions 查到的任意 msgType）
  raw <METHOD> <path> [jsonQuery]    直接调用任意接口（调试用）

环境变量:
  OPPLE_TOKEN / OPPLE_PROJECTCODE    临时覆盖配置文件凭据
`;

function printTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function getClient() {
  if (process.env.OPPLE_TOKEN && process.env.OPPLE_PROJECTCODE) {
    return new OppleClient({ token: process.env.OPPLE_TOKEN, projectCode: process.env.OPPLE_PROJECTCODE });
  }
  return OppleClient.loadConfig();
}

// ---- 灯光控制预设（逆向自 FindDeviceAbility，msgType 命令字表） ----
const LIGHT = {
  switch: '0x03110000',   // 开关（0/1）
  bright: '0x03130000',   // 亮度（1-255）
  cct: '0x031B0000',      // 色温（1800-12000K）
  duv: '0x14170000',      // DUV（-8~8），需带回路号：values = [回路,duv]
  color: '0x046B0000',    // 颜色 CXCY（回路,颜色值）
};

// 官方预设颜色（CXCY 打包值，来源：FindDeviceAbility 枚举）
const COLORS = {
  藤萝紫: 207948282, 山海青: 214175122, 竹影绿: 242749551, 胡杨黄: 301010749,
  桃林红: 299502821, 星云: 162793604, 梦幻: 136054106, 火烧云: 324275309,
  加州阳光: 288098833, 晚霞: 211158890,
};

// 日光模式预设（高16位=色温K，来源：FindDeviceAbility 0x046F 枚举）
const DAYLIGHT = { 晨曦: 196672844, 旭日: 262209228, 沐阳: 327745279, 夕照: 177011814, 明月: 655424537, 静夜: 118029324 };

// 悦动灯效（0x14 系列，仅灯带类设备支持；参数序=回路,悦动模式,颜色,速度,方向[,渐变时长]）
const SCENE = {
  流水: { msg: '0x14030000', mode: 0, extra: ['循环'] },        // 循环0/1
  跑马: { msg: '0x14050000', mode: 1 },                          // 颜色,速度,方向
  呼吸: { msg: '0x14070000', mode: 2 },                          // 颜色,速度
  律动: { msg: '0x14090000', mode: 3 },                          // 颜色,速度
  静态色温渐变: { msg: '0x140B0000', mode: 4 },                  // 起始色温,结束色温,方向
  动态色温渐变: { msg: '0x140D0000', mode: 5 },                  // 起始色温,结束色温,渐变时长(1-10)
  静态颜色渐变: { msg: '0x140F0000', mode: 6 },                  // 颜色,方向
};

/** xy 色坐标（0-1）→ CXCY 打包值（高16位 cx*10000，低16位 cy*10000） */
function packCXCY(cx, cy) {
  return ((Math.round(cx * 10000) & 0xFFFF) << 16) | (Math.round(cy * 10000) & 0xFFFF);
}

function resolveColor(input) {
  if (COLORS[input] !== undefined) return COLORS[input];
  if (/^-?\d+$/.test(input)) return Number(input);
  const m = input.match(/^#([0-9a-fA-F]{6})$/);
  if (m) { // 粗略 sRGB→xy 转换（伽马展开+归一化投影）
    const [r, g, b] = [1, 3, 5].map(i => parseInt(m[1].slice(i - 1, i + 1), 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    const sum = X + Y + Z || 1;
    return packCXCY(X / sum, Y / sum);
  }
  const m2 = input.split(',').map(Number);
  if (m2.length === 2 && m2.every(n => n > 0 && n < 1)) return packCXCY(m2[0], m2[1]);
  throw new Error(`无法识别颜色: ${input}（支持：预设名 / #RRGGBB / "cx,cy" / 原始数值）`);
}

export async function run(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return; }

  if (cmd === 'token') {
    const sub = rest[0];
    if (sub === 'save') {
      const [, token, projectCode] = rest;
      if (!token || !projectCode) throw new Error('用法: opple token save <token> <projectCode>');
      const c = new OppleClient({ token, projectCode });
      const path = c.saveConfig();
      console.log(`已保存到 ${path}`);
      return;
    }
    if (sub === 'check') {
      const c = getClient();
      const r = await c.checkToken();
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    throw new Error('用法: opple token save|check');
  }

  if (cmd === 'homes') {
    const c = getClient();
    const homes = await c.homeList();
    const rows = (homes ?? []).map(h => [h.ProjectCode, h.Name ?? h.HomeName, h.CreateTime]);
    printTable(rows, ['ProjectCode', 'Name', 'CreateTime']);
    return;
  }

  if (cmd === 'tree') {
    const c = getClient();
    const homes = await c.tree();
    for (const home of homes) {
      const on = home.onlineCount != null ? `（在线 ${home.onlineCount}/${home.deviceCount}）` : '';
      console.log(`\n🏠 ${home.name} [${home.projectCode}]${on}`);
      for (const room of home.rooms) {
        console.log(`  🛏  ${room.name}（${room.devices.length} 台设备）`);
        for (const d of room.devices) {
          const flag = d.online ? '●' : '○';
          const parent = d.parent && d.parent !== d.vDeviceId ? ` ← ${d.parent}` : '';
          console.log(`      ${flag} ${d.name}  [${d.vDeviceId}] ${d.type ?? ''}${d.protocol ? ` (${d.protocol})` : ''}${parent}`);
        }
      }
    }
    if (!homes.length) console.log('（无家庭）');
    return;
  }

  if (cmd === 'devices') {
    const filter = rest[0]; // 可选：房间名或 Gpno
    const c = getClient();
    const homes = await c.tree();
    const rows = [];
    for (const home of homes) {
      for (const room of home.rooms) {
        if (filter && room.name !== filter && String(room.gpno) !== filter) continue;
        for (const d of room.devices) {
          rows.push([d.vDeviceId, d.name, home.name, room.name, d.type ?? '-', d.online ? '在线' : '离线']);
        }
      }
    }
    if (filter && !rows.length) {
      console.log(`没有匹配房间: ${filter}（先运行 opple tree 查看房间列表）`);
      return;
    }
    printTable(rows, ['VDeviceId', '名称', '家庭', '房间', '品类', '状态']);
    console.log(`\n共 ${rows.length} 台设备`);
    return;
  }

  if (cmd === 'actions') {
    const vDeviceId = rest[0];
    if (!vDeviceId) throw new Error('用法: opple actions <vDeviceId>');
    const c = getClient();
    const ability = await c.actionAbility(vDeviceId);
    const rows = [];
    for (const ch of ability?.ActionSet ?? []) {
      for (const a of ch.ActionList ?? []) {
        for (const v of a.Values ?? []) {
          const enums = (v.EnumValue ?? []).slice(0, 6).map(x => `${x.CnName}=${x.Value}`).join(' ');
          rows.push([a.MsgType, a.Desc, v.Name, `${v.Min ?? ''}~${v.Max ?? ''}`, v.ValueType?.replace('UIControl_', ''), enums]);
        }
      }
    }
    printTable(rows, ['MsgType', '命令', '参数', '范围', '控件', '枚举']);
    console.log(`\n共 ${rows.length} 个可调用动作（opple call <id> <msgType> <v1,v2,…>）`);
    return;
  }

  if (cmd === 'light') {
    // opple light <vDeviceId> <op> <value...>
    // op: on/off/bright/cct/duv/color/daylight
    const [vDeviceId, op, ...vals] = rest;
    if (!vDeviceId || !op) throw new Error('用法: opple light <vDeviceId> <on|off|bright|cct|duv|color|daylight> <值>');
    const c = getClient();
    let r;
    switch (op) {
      case 'on': case 'off':
        r = await c.callAction(vDeviceId, LIGHT.switch, [op === 'on' ? 1 : 0]);
        break;
      case 'bright': { // 支持百分比：opple light id bright 80% -> 80%*255
        let v = vals[0];
        if (String(v).endsWith('%')) v = Math.round(parseFloat(v) * 255 / 100);
        v = Number(v);
        if (!(v >= 1 && v <= 255)) throw new Error('亮度范围 1-255 或 1%-100%');
        r = await c.callAction(vDeviceId, LIGHT.bright, [v]);
        break;
      }
      case 'cct': {
        const v = Number(vals[0]);
        if (!(v >= 1800 && v <= 12000)) throw new Error('色温范围 1800-12000K');
        r = await c.callAction(vDeviceId, LIGHT.cct, [v]);
        break;
      }
      case 'duv': {
        const v = Number(vals[0]);
        if (!(v >= -8 && v <= 8)) throw new Error('DUV 范围 -8~8');
        r = await c.callAction(vDeviceId, LIGHT.duv, [0, v]); // 回路号0 + duv
        break;
      }
      case 'color': {
        const v = resolveColor(vals[0] ?? '');
        r = await c.callAction(vDeviceId, LIGHT.color, [0, v]);
        break;
      }
      case 'daylight': { // 日光模式预设（0x046F）：晨曦/旭日/沐阳/夕照/明月/静夜
        const v = DAYLIGHT[vals[0]] ?? Number(vals[0]);
        if (v === undefined) throw new Error(`日光模式支持: ${Object.keys(DAYLIGHT).join('/')}`);
        r = await c.callAction(vDeviceId, '0x046F0000', [0, v]);
        break;
      }
      default:
        throw new Error(`未知操作: ${op}`);
    }
    console.log(`✅ 已下发 ${op} ${vals.join(' ')} -> 设备 ${vDeviceId}`);
    return;
  }

  if (cmd === 'scene') {
    // opple scene <vDeviceId> <效果> [options]
    // 例: opple scene 2122018 跑马 speed=60 direction=forward color=晚霞
    const [vDeviceId, effectName, ...optPairs] = rest;
    if (!vDeviceId || !effectName) {
      console.log('用法: opple scene <vDeviceId> <效果> [key=value …]');
      console.log('效果: ' + Object.keys(SCENE).join(' / '));
      console.log('参数: color=<预设|#RGB|cx,cy> speed=<1-100> direction=<forward|reverse>');
      console.log('      cctFrom=<K> cctTo=<K> duration=<1-10> loop=<0|1>');
      return;
    }
    const sc = SCENE[effectName];
    if (!sc) throw new Error(`未知效果: ${effectName}，支持: ${Object.keys(SCENE).join('/')}`);
    const opts = {};
    for (const p of optPairs) {
      const [k, v] = p.split('=');
      if (k) opts[k] = v;
    }
    const color = opts.color ? resolveColor(opts.color) : COLORS.星云;
    const speed = Number(opts.speed ?? 50);
    const direction = opts.direction === 'reverse' ? 1 : 0;
    const loop = opts.loop === '0' ? 0 : 1;
    let values;
    switch (effectName) {
      case '流水':   values = [0, sc.mode, color, speed, loop]; break;             // 回路,模式,颜色,速度,循环
      case '跑马':   values = [0, sc.mode, color, speed, direction]; break;        // 回路,模式,颜色,速度,方向
      case '呼吸':   values = [0, sc.mode, color, speed]; break;
      case '律动':   values = [0, sc.mode, color, speed]; break;
      case '静态色温渐变': values = [0, sc.mode, Number(opts.cctFrom ?? 3000), Number(opts.cctTo ?? 6000), direction]; break;
      case '动态色温渐变': values = [0, sc.mode, Number(opts.cctFrom ?? 3000), Number(opts.cctTo ?? 6000), Number(opts.duration ?? 5)]; break;
      case '静态颜色渐变': values = [0, sc.mode, color, direction]; break;
      default: throw new Error('内部错误');
    }
    const c = getClient();
    await c.callAction(vDeviceId, sc.msg, values);
    console.log(`✅ 灯效 ${effectName} -> 设备 ${vDeviceId} (${values.join(',')})`);
    return;
  }

  if (cmd === 'call') {
    const [vDeviceId, msgType, valuesStr] = rest;
    if (!vDeviceId || !msgType) throw new Error('用法: opple call <vDeviceId> <msgType> <v1,v2,…>');
    const values = (valuesStr ?? '').split(',').filter(s => s !== '').map(v => {
      const n = Number(v);
      return /^-?\d+(\.\d+)?$/.test(v) ? n : v;
    });
    const c = getClient();
    await c.callAction(vDeviceId, msgType, values);
    console.log(`✅ 已下发 ${msgType} values=${values.join(',')} -> ${vDeviceId}`);
    return;
  }

  if (cmd === 'raw') {
    const [method, path, queryJson] = rest;
    if (!method || !path) throw new Error('用法: opple raw <METHOD> <path> [jsonQuery]');
    const c = getClient();
    const query = queryJson ? JSON.parse(queryJson) : undefined;
    const r = method.toUpperCase() === 'POST'
      ? await c.post(path, query ?? {}, undefined)
      : await c.get(path, query);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  throw new Error(`未知命令: ${cmd}（输入 opple help 查看）`);
}
