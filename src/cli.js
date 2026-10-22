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
  status <vDeviceId>                 读设备实存状态（灯效参数/亮度等，与 App 显示同源，含更新时间）
  light <id> <op> <值>               灯光控制
    op: on / off / bright(1-255或%) / cct(1800-12000K) / duv(-8~8)
        color(预设名|#RGB|cx,cy) / daylight(晨曦|旭日|沐阳|夕照|明月|静夜)
  scene <id> <效果> [key=value…]      灯效控制（悦动模式，灯带类设备）
    效果: 流水/跑马/呼吸/律动/静态色温渐变/动态色温渐变
    无参数 = 总开关切换，颜色/速度沿用设备当前设置
    colors=色1,色2 speed=1-100 direction=0|1 loop=0|1 → 专属命令字全参下发
    colors 每项: 预设名 / #RRGGBB / 8位CXCYhex（自动补零 6 组防吞参）
    速度换算: 1~20 同最慢档; 60 档≈1.03m/s, 100 档≈2.07m/s（按 9.69m 带标定）
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

// 悦动灯效（灯带类设备）。无参数时走 0x14010000 悦动总开关 [回路,模式]，沿用设备当前颜色/速度；
// 带 colors/speed/direction 参数时走各效果专属命令字，values 顺序=能力表 KeyId 升序：
//   流水 0x14030000: [回路,模式,颜色HexString,速度U8,循环U8,方向U8]
//   跑马 0x14050000: [回路,模式,颜色HexString,速度U8,方向U8]
//   呼吸 0x14070000: [回路,模式,颜色HexString,速度U8]
//   律动 0x14090000: [回路,模式,颜色HexString,速度U8]
// 颜色 HexString 是变长字段，固件把其后全部字节吞进 24 字节(6组CXCY)颜色缓冲区，
// 必须补零到 48 个 hex 字符，否则速度/方向字节被当作颜色坐标（速度值会渲染成白块）。
// 速度 1-100：1~20 同为最慢档；20→100 循环周期线性 T(s)=16.40-0.117s 秒（9.69m 带），
// 流速 v=9.69/T，即 60 档≈1.03 m/s、100 档≈2.07 m/s。
// 各灯效参数在设备上有独立存储槽位（opple status <id> 可读）：流水 0x1E09-0C、
// 跑马 0x1E0D-0F、呼吸 0x1E10-11、律动 0x1E12-13（颜色/速度[/循环/方向]）。
// 渲染语义（速度均为「周期与档位线性」）：跑马=色块流动，T(s)=16.40-0.117s 秒/圈；
// 律动=全带颜色交替闪烁，交替间隔 T(s)=5.24-0.051s 秒（100 档≈0.14s≈7Hz 频闪）。
const SCENE = {
  流水: { mode: 0, full: '0x14030000', extra: ['loop', 'direction'], defSpeed: 35 },
  跑马: { mode: 1, full: '0x14050000', extra: ['direction'], defSpeed: 24 },
  呼吸: { mode: 2, full: '0x14070000', extra: [], defSpeed: 35 },
  律动: { mode: 3, full: '0x14090000', extra: [], defSpeed: 40 },
  静态色温渐变: { mode: 4, full: '0x140B0000' },
  动态色温渐变: { mode: 5, full: '0x140D0000' },
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

  if (cmd === 'status') {
    // opple status <vDeviceId>  读设备实存状态（与 App 显示同源，写后读回断言用）
    const vDeviceId = rest[0];
    if (!vDeviceId) throw new Error('用法: opple status <vDeviceId>');
    const c = getClient();
    const { device, status } = await c.deviceStatus(vDeviceId);
    console.log(`设备: ${device.DeviceName ?? ''}  vDeviceId=${vDeviceId}  deviceId=${device.DeviceId}  mac=${device.Mac ?? ''}\n`);
    // 颜色类状态（HexString，每组 8 位 = CXCY 打包：高16位 cx*10000 / 低16位 cy*10000）
    // 注：0x1A04 颜色模板是模板 ID 非 CXCY，不解析
    const COLOR_TYPES = ['0x1E09', '0x1E0D', '0x1E10', '0x1E12', '0x1E1A'];
    const rows = [];
    for (const s of status) {
      let val = String(s.Value);
      if (COLOR_TYPES.includes(s.StatusType)) {
        const groups = (val.match(/.{8}/g) ?? []).map(g => {
          const cx = parseInt(g.slice(0, 4), 16) / 10000, cy = parseInt(g.slice(4), 16) / 10000;
          return `(${cx.toFixed(3)},${cy.toFixed(3)})`;
        });
        if (groups.length) val = `${groups.length}色 ${groups.join(' ')}`;
      } else if (s.StatusType === '0x0300') {
        val = `${val} (${Math.round((Number(val) / 255) * 100)}%)`;
      }
      rows.push([s.StatusType, s.Name, val, new Date(s.TimeStamp).toLocaleTimeString()]);
    }
    printTable(rows, ['状态码', '名称', '值', '更新时间']);
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
    // opple scene <vDeviceId> <效果> [key=value…]
    // 例: opple scene 2122018 跑马
    //     opple scene 2122018 跑马 colors=红,蓝 speed=60 direction=1
    const [vDeviceId, effectName, ...opts] = rest;
    if (!vDeviceId || !effectName) {
console.log('用法: opple scene <vDeviceId> <效果> [colors=色1,色2 speed=1-100 direction=0|1 loop=0|1]');
console.log('效果: ' + Object.keys(SCENE).join(' / ') + '（colors 每项: 预设名/#RRGGBB/8位CXCYhex）');
      return;
    }
    const sc = SCENE[effectName];
    if (!sc) throw new Error(`未知效果: ${effectName}，支持: ${Object.keys(SCENE).join('/')}`);
    const opt = {};
    for (const o of opts) {
      const i = o.indexOf('=');
      if (i <= 0) throw new Error(`参数需为 key=value 形式: ${o}`);
      opt[o.slice(0, i)] = o.slice(i + 1);
    }
    let msg = '0x14010000'; // 悦动总开关：只切模式，颜色/速度沿用设备当前值
    let values = [0, sc.mode];
    if (sc.full && (opt.colors || opt.speed || opt.direction || opt.loop)) {
      // 完整参数模式：走专属命令字，全参下发（values 数量必须=能力表 KeyId 个数）
      msg = sc.full;
      let colorHex = '10EE1123081C055A09B408840B4C0BAE0C96076A0EBA0E38'; // 能力表默认 6 色彩虹
      if (opt.colors) {
        colorHex = opt.colors.split(',').map(t => {
          if (/^[0-9a-fA-F]{8}$/.test(t)) return t.toUpperCase(); // 已是 CXCY 打包 hex
          return ((resolveColor(t) >>> 0).toString(16)).padStart(8, '0').toUpperCase();
        }).join('');
      }
      colorHex = colorHex.padEnd(48, '0').slice(0, 48); // 必须满 6 组（24 字节），防吞参
      const speed = Math.min(100, Math.max(1, Number(opt.speed) || sc.defSpeed));
      values = [0, sc.mode, colorHex, speed];
      if (sc.extra.includes('loop')) values.push(opt.loop === undefined ? 1 : Number(opt.loop));
      if (sc.extra.includes('direction')) values.push(opt.direction === undefined ? 0 : Number(opt.direction));
    }
    const c = getClient();
    await c.callAction(vDeviceId, msg, values);
    console.log(`✅ 灯效 ${effectName} -> 设备 ${vDeviceId} (${msg} ${values.join(',')})`);
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
