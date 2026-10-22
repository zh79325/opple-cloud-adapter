#!/usr/bin/env node
// 欧享家局域网 UDP 直控探测工具（零依赖，协议依据 docs/reverse-engineering-report.md 6.4
// 与 data/decompiled.js 逆向：sendDeviceControl@554920 / getPduPacketData@564884 /
// encryptData@564864 / encryptLanData@564870 / OppleUDPPort@557047）
//
// 用法：
//   node tools/udp-probe.js discover                       # 广播发现设备，落盘 data/lan-devices.json
//   node tools/udp-probe.js control <devId> on|off         # 向设备发开关灯指令（0x03110000）
//   node tools/udp-probe.js authtest <devId> on|off        # 真/假 uCloudId 各发一次，验证设备端校验强度
// 通用选项：
//   --ucloudid=N     用户云 ID（默认 1；App 登录态中的 ucloundid，可抓包获得）
//   --dport=65501    目标端口（默认 OPIOTIPPort=65501；发现回包里若带端口则优先用回包值）
//   --timeout=300    等待 ACK 毫秒数（App 默认 300ms）
//
// ⚠ PDU 字节布局为逆向推测 v1：帧内字段顺序/偏移尚未用真实回包校准。
//   先跑 discover——脚本会把收到的全部原始回包 hex 落盘，对照校准 buildPdu() 后再做控制验证。
//
// ── 2026-10-22 真机验证结果（家里实测）──
// ✅ 发现链路完全打通：绑 55001 广播（无 token、uCloudId=0），两个设备均回 SearchDevice_res——发现零凭证实锤。
// ✅ 回包实锤（data/lan-devices.json）：
//   192.168.0.119:55002（187B，网关类）：外层 SrcIP(U32 c0a80077=192.168.0.119) + SrcPort(U32 0000d6d9=55001)
//     + DstIP(c0a800ff=192.168.0.255 广播) + DstPort + 2B 保留，共 20B 路由头；内层 167B PDU：
//     03f2(L2Type=1010✓) ... 02020000(SearchDevice_res✓) ... 多组设备记录 ... 尾部 aabbcc01(ProjectCodeKey✓)
//   192.168.0.139:55001（102B）：03f2 + 头部约 100B + 2B 尾 —— 印证「PDU 头部 100 字节」分段设计✓
// ❌ 控制链路：v1 布局的 0x03110000 包发两设备 65501 端口均 500ms 无响应——控制包对布局/加密严格，
//   需抓 App 真实控制包校准：sudo tcpdump -i any 'udp port 55001 or udp port 65501' -XX
//   （开着 tcpdump 用欧普 App 开关一次灯，取 App→设备包的 hex 对照重写 buildPdu）

import { createSocket } from 'node:dgram';
import { parseArgs } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '../data/lan-devices.json');

// ---- 逆向实锤常量（decompiled.js@557020-557047）----
const APP_LOCAL_PORT = 55001;                 // OppleUDPPort.LocalPort：App 本地 UDP 绑定端口
const BROADCAST_IP = '255.255.255.255';       // getPduPacketData 中 DstIP 默认值
const MSG = {
  SearchDevice_req: 33619968,                 // 0x02010000
  SearchDevice_res: 33685504,                 // 0x02020000（=ListenLanDevice）
  LightSwitch: 0x03110000,                    // 云端 CallAction 同款开关命令字
};
const L2_TYPE = 1010;                         // OppleLink 帧类型
const XOR_KEY = new TextEncoder().encode('qazedcwsx1ujmyhntgb9'); // OPUniversalKey（20 字节）

const hex = (buf) => Buffer.from(buf).toString('hex');
const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

// ---- 加密（逆向实锤：两段异或，key 20 字节周期）----
// encryptData：字节 [100,124) 异或（PDU 头部区段尾部）
function encryptHead(bytes) {
  for (let i = 100; i < 124 && i < bytes.length; i++) bytes[i] ^= XOR_KEY[(i - 100) % 20];
  return bytes;
}
// encryptLanData：字节 [124, len) 异或（数据区）
function encryptBody(bytes) {
  for (let i = 124; i < bytes.length; i++) bytes[i] ^= XOR_KEY[(i - 124) % 20];
  return bytes;
}

// ---- PDU 构造（推测 v1：大端序；S16/S32ToBytesArray 反转后均呈大端）----
// 头 100 字节明文（寻址段），[100,124) 头部异或，[124,...) 数据异或。
// 布局对照 getPduPacketData 字段顺序排列，偏移未实锤——discover 回包校准后修正。
function buildPdu({ msgType, srcObjectId, dstObjectId, appendData = [], srcTransNo = 0 }) {
  const head = Buffer.concat([
    u16(L2_TYPE),          // 0   L2Type
    u8(1),                 // 2   Proto（getPduPacketData 默认 1）
    u32(msgType),          // 3   MsgType
    u32(srcTransNo),       // 7   SrcTransNo（DstTransNo 请求侧恒 0）
    u32(0),                // 11  DstTransNo
    u8(0),                 // 15  SrcServiceFlag
    u8(0),                 // 16  SrcObjectType
    u32(srcObjectId),      // 17  SrcObjectID0（=uCloudId）
    u8(0),                 // 21  DstServiceFlag
    u8(1),                 // 22  DstObjectType（getPduPacketData 默认 1）
    u32(dstObjectId),      // 23  DstObjectID0（=parseInt(deviceId)）
  ]);
  const body = Buffer.concat([u16(appendData.length), Buffer.from(appendData)]);
  const pdu = Buffer.alloc(100, 0);          // 头部补零至 100（异或起始偏移）
  head.copy(pdu, 0);
  return Buffer.concat([encryptHead(pdu), ...[encryptBody(body)]]);
}

// values 序列化：按 CallAction 语义十进制逗号串；UDP AppendData 推测为逐个 U32 大端
// TODO：真实宽度由 FindDeviceAbility 的 Values[].Type 决定（IntType U8/U16/U32/U48/U64），待回包/抓包校准
function serializeValues(str) {
  return (str ?? '').split(',').filter(Boolean).map((v) => [...u32(Number(v))]).flat();
}

// ---- 发现：广播 SearchDevice_req，收集 SearchDevice_res ----
function discover(seconds = 10) {
  const sock = createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map();
  sock.on('error', (e) => { console.error('socket 错误:', e.message); process.exit(1); });
  sock.on('message', (buf, rinfo) => {
    const raw = hex(buf);
    console.log(`\n收到 ${buf.length}B 来自 ${rinfo.address}:${rinfo.port}`);
    console.log(`  hex: ${raw}`);
    // 解析启发式：ASCII 区段里找 mac 形态字符串与纯数字设备号（真实布局待校准）
    const text = buf.toString('latin1');
    const mac = text.match(/([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/)?.[0] ?? null;
    found.set(`${rinfo.address}:${rinfo.port}`, {
      ip: rinfo.address, port: rinfo.port, len: buf.length, hex: raw, mac,
      msgTypeMatch: [...new Set([...raw.matchAll(/0202(?:0000|0100)/g)])].length,
    });
  });
  sock.bind(APP_LOCAL_PORT, () => {
    sock.setBroadcast(true);
    console.log(`已绑定本地 :${APP_LOCAL_PORT}，开始广播 SearchDevice_req（${seconds}s）...`);
    const req = buildPdu({ msgType: MSG.SearchDevice_req, srcObjectId: 0, dstObjectId: 0 });
    const timer = setInterval(() => {
      sock.send(req, 65501, BROADCAST_IP);
      sock.send(req, 55001, BROADCAST_IP); // 设备侧端口未知，两个候选端口同发
    }, 1000);
    setTimeout(() => {
      clearInterval(timer);
      sock.close();
      const list = [...found.values()];
      mkdirSync(dirname(OUT_FILE), { recursive: true });
      writeFileSync(OUT_FILE, JSON.stringify({ discoveredAt: new Date().toISOString(), devices: list }, null, 2));
      console.log(`\n==== 发现 ${list.length} 个响应源，已落盘 ${OUT_FILE} ====`);
      for (const d of list) console.log(`  ${d.ip}:${d.port}  len=${d.len}  mac=${d.mac ?? '?'}`);
      console.log('\n下一步：对照回包 hex 校准 buildPdu() 布局，再跑 control/authtest');
    }, seconds * 1000);
  });
}

// ---- 控制：向设备/网关发指令，等 ACK ----
function loadDevices() {
  if (!existsSync(OUT_FILE)) {
    console.error(`未找到 ${OUT_FILE}，先跑: node tools/udp-probe.js discover`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(OUT_FILE, 'utf8')).devices;
}

function sendControl(dev, { ucloudid, dport, timeout, msgType, values, fakeId = false }) {
  return new Promise((resolve) => {
    const targetId = fakeId ? Number(dev.deviceId ?? 0) + 1 : Number(dev.deviceId ?? 0);
    const pdu = buildPdu({
      msgType,
      srcObjectId: fakeId ? ucloudid + 1 : ucloudid, // authtest：故意错的 uCloudId
      dstObjectId: targetId,
      appendData: serializeValues(values),
      srcTransNo: Math.floor(Math.random() * 0xffffffff),
    });
    const sock = createSocket('udp4');
    const t0 = Date.now();
    const done = (result) => { try { sock.close(); } catch { /* already */ } resolve(result); };
    sock.on('message', (buf, rinfo) => {
      const ms = Date.now() - t0;
      console.log(`  ACK ${ms}ms 来自 ${rinfo.address}:${rinfo.port}  hex: ${hex(buf)}`);
      done({ ok: true, ms, reply: hex(buf) });
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(pdu, dport, dev.ip);
      console.log(`  → ${dev.ip}:${dport}  uCloudId=${fakeId ? ucloudid + 1 + '(假)' : ucloudid}  pdu(${pdu.length}B): ${hex(pdu)}`);
    });
    setTimeout(() => done({ ok: false, ms: Date.now() - t0, note: '超时无响应（App 超时码 30098 同款表现）' }), timeout);
  });
}

async function controlCmd(devId, action, opts, { fakeId = false } = {}) {
  const devices = loadDevices();
  const dev = devices.find((d) => d.ip === devId) ?? devices[0];
  if (!dev) { console.error('设备表为空，先 discover'); process.exit(1); }
  if (!devices.some((d) => d.ip === devId)) {
    console.log(`⚠ 设备表中无 "${devId}"，回退用首个发现源 ${dev.ip}:${dev.port}（发现协议尚未解析出 deviceId 映射）`);
  }
  console.log(`发送 ${action.toUpperCase()}（msgType=0x03110000, values=${action === 'on' ? '1' : '0'}）`);
  const r = await sendControl(dev, {
    ...opts,
    msgType: MSG.LightSwitch,
    values: action === 'on' ? '1' : '0',
    fakeId,
  });
  console.log(`  结果: ${r.ok ? `生效（${r.ms}ms）` : `无响应（${r.ms}ms）`}`);
  return r;
}

// ---- 全状态控制包（2026-10-22 权威布局：decompiled.js 四层协议栈 @557049-557561/@564590-565182 + 双包抓包验证）----
// OppleLink(20B) + OppleNetwork(80B) + OppleSession(16B) + OppleAppHead(8B) + AppendData
// CheckSum = CRC-16/XMODEM(poly 0x1021, init 0)，输入 = Session(CheckSum=0) + AppHead + AppendData【明文】
// 加密 = encryptLanData：@124 起 XOR generatePasswordKey(macOrKey)[i%20]；广播=OPUniversalKey，单播=目标 MAC hex 派生
// AppendData(52B, 13×LE U32)：[0x30000100, groupId, 1, 1, 0x4FFFF, 5, 1, 0, 1, 6, 亮度%, 7, 色温0-10000]
function localLanIp() {
  for (const list of Object.values(networkInterfaces()))
    for (const ni of list ?? [])
      if (ni.family === 'IPv4' && !ni.internal && /^192\.168\./.test(ni.address)) return ni.address;
  return '192.168.0.108';
}

function calcCRC(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// generatePasswordKey（decompiled.js@564809）：20 字符逐字符 TextEncoder；MAC hex 每 2 字符 parseInt(,16) 回绕取 20 字节
function generatePasswordKey(str) {
  if (!str) return null;
  const out = [];
  if (str.length === 20) {
    for (let i = 0; i < 20; i++) out.push(...new TextEncoder().encode(str.substring(i, i + 1)));
  } else {
    for (let i = 0; i < 20; i++) {
      const pos = (i % (str.length / 2)) * 2;
      out.push(parseInt(str.substring(pos, pos + 2), 16));
    }
  }
  return out;
}

// getSrcTransNo（decompiled.js@564598）：((rnd 1..14 ^ now&15) << 16) | now&0xFFFF
function getSrcTransNo() {
  const now = Date.now();
  return ((((Math.floor(Math.random() * 15) + 1) ^ (now & 15)) << 16) | (now & 0xffff)) >>> 0;
}

function buildStatusPacket({ bright = 77, cct = 5000, groupId = 0x004020a4, keyStr, extraKv = [], srcIp, transNo, msgType = 0x02940000, appendOverride } = {}) {
  const ipB = (srcIp ?? localLanIp()).split('.').map(Number);
  const u32b = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  // KV 对：已知 (6,亮度)(7,色温)；颜色键号未实锤，extraKv 追加实验（候选 8 / 14，主状态候选 12）
  const plainAppend = appendOverride ?? Buffer.concat([
    le32(0x30000100), le32(groupId),
    le32(1), le32(1), le32(0x0004ffff), le32(5), le32(1), le32(0), le32(1), le32(6),
    le32(bright), le32(7), le32(cct),
    ...extraKv.flat().map(le32),
  ]);
  const msgLen = 24 + plainAppend.length;
  const head = Buffer.concat([
    // OppleLink 20B
    Buffer.from(ipB), u32b(APP_LOCAL_PORT),
    Buffer.from([255, 255, 255, 255]), u32b(APP_LOCAL_PORT),
    u32b(1010),
    // OppleNetwork 80B
    u32b(10101),            // L3Version（抓包 0x2775）
    u32b(0),                // ServType
    u32b(104 + plainAppend.length), // DataPkgLen
    u32b(1),                // L3Id
    u32b(2),                // Offset
    u32b(3),                // Ttl
    u32b(3),                // Proto = UniversalXor
    u32b(5),                // L3ChkSum
    u32b(0),                // SrcServiceFlag
    u32b(0),                // SrcObjectType
    u32b(groupId),          // SrcObjectID0
    u32b(0), u32b(0), u32b(0),      // SrcObjectID1-3
    u32b(0),                // DstServiceFlag
    u32b(1),                // DstObjectType
    u32b(groupId),          // DstObjectID0（目标=分组，广播语义）
    u32b(0), u32b(0), u32b(0),      // DstObjectID1-3
    // OppleSession 16B（CheckSum 占位 0，随后回填）
    u32b(transNo ?? getSrcTransNo()), // SrcTransNo（App 实测为会话内递增小整数 51→52，非 getSrcTransNo 算法值）
    u32b(0xffffffff),       // DstTransNo（广播）
    u32b(msgLen),           // MsgLen
    u32b(0),                // CheckSum 占位
    // OppleAppHead 8B
    u32b(msgType),          // MsgType（0x02940000 全状态 / 0x059b0000 场景重置）
    u32b(0),                // Reserve
  ]);
  const crc = calcCRC(Buffer.concat([head.subarray(100), plainAppend]));
  head.writeUInt32BE(crc, 112);
  // encryptLanData：@124 起 XOR key
  const key = generatePasswordKey(keyStr ?? 'qazedcwsx1ujmyhntgb9');
  const enc = Buffer.from(plainAppend);
  for (let i = 0; i < enc.length; i++) enc[i] ^= key[i % 20];
  return Buffer.concat([head, enc]);
}

// 发送 + 收 3s 响应（App 模式：100ms 双发提高到达率）
function sendStatus(pkt, waitMs = 3000) {
  return new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const replies = [];
    sock.on('message', (buf, rinfo) => replies.push({ from: `${rinfo.address}:${rinfo.port}`, len: buf.length, hex: buf.toString('hex') }));
    sock.bind(APP_LOCAL_PORT, () => {
      sock.setBroadcast(true);
      sock.send(pkt, APP_LOCAL_PORT, BROADCAST_IP);
      setTimeout(() => sock.send(pkt, APP_LOCAL_PORT, BROADCAST_IP), 100);
      console.log(`  → 广播 ${BROADCAST_IP}:${APP_LOCAL_PORT}  本机身份 ${localLanIp()}:${APP_LOCAL_PORT}  包 ${pkt.length}B`);
      console.log(`  hex: ${pkt.toString('hex')}`);
      setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(replies); }, waitMs);
    });
  });
}

async function cctCmd(cct, bright) {
  if (!Number.isFinite(cct) || cct < 0 || cct > 10000) { console.error('用法: cct <色温 0-10000> [亮度 0-100]'); process.exit(1); }
  const pkt = buildStatusPacket({ cct, bright: bright ?? 77 });
  console.log(`下发全状态包：色温=${cct}（刻度 0-10000） 亮度=${bright ?? 77}%`);
  const replies = await sendStatus(pkt);
  console.log(`\n==== ${replies.length} 个回包 ====`);
  for (const r of replies) console.log(`  ${r.from}  ${r.len}B  ${r.hex.slice(0, 80)}...`);
  if (!replies.length) console.log('  无回包——若灯具视觉未变化，把 3 秒内的灯具反应告知用于判读');
}

// cxcy 编码（decompiled.js@1613224 _value2CxCy 反推）：高 16 位 = cx*10000，低 16 位 = cy*10000
// 颜色走 CIE 1931 x,y 色坐标（云端 statusCode 0x1A04:65535:14 type=cxcy，cxcyUtil.XY2CxCYValue）
function cxcyEncode(cx, cy) {
  return (((Math.round(cx * 10000) & 0xffff) << 16) | (Math.round(cy * 10000) & 0xffff)) >>> 0;
}
const CIE = {
  red: [0.640, 0.330],
  green: [0.300, 0.600],
  blue: [0.150, 0.060],
  purple: [0.300, 0.150],
};

// 颜色键号归因实验：SrcIP 伪造为 App 手机（192.168.0.108）+ SrcTransNo 接续 App 会话计数器
// （App 实测 SrcTransNo=51→52 递增且灯生效；本机随机大数全被丢弃——疑似设备端按 SrcObjectID0 做
//   会话计数/重放保护，故从 53 开始冒充 App 计数器续发）
//   ① (8,红)  ② (14,红)  ③ (12,1)+(14,红)  ④ (12,1)+(8,蓝) —— 肉眼归因颜色键号
async function colorCmd() {
  const APP_IP = '192.168.0.108';
  const variants = [
    ['① 键8=红', [[8, cxcyEncode(...CIE.red)]]],
    ['② 键14=红', [[14, cxcyEncode(...CIE.red)]]],
    ['③ 主状态12=1 + 键14=红', [[12, 1], [14, cxcyEncode(...CIE.red)]]],
    ['④ 主状态12=1 + 键8=蓝', [[12, 1], [8, cxcyEncode(...CIE.blue)]]],
  ];
  // 0x059b0000 场景重置包（App 每次操作成对首发）：AppendData = FF FF FF FF 00（129B）
  const resetAppend = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]);
  let replies = [];
  for (let i = 0; i < variants.length; i++) {
    const [label, kv] = variants[i];
    const reset = buildStatusPacket({ extraKv: [], srcIp: APP_IP, transNo: 53 + i * 2, msgType: 0x059b0000, appendOverride: resetAppend });
    const pkt = buildStatusPacket({ bright: 100, cct: 5000, extraKv: kv, srcIp: APP_IP, transNo: 54 + i * 2 });
    console.log(`\n== ${label}  亮度=100  SrcIP=${APP_IP}(伪)  SrcTransNo=${53 + i * 2}/${54 + i * 2}  重置129B+状态${pkt.length}B ==`);
    const r1 = await sendStatus(reset, 1200);
    const r2 = await sendStatus(pkt, 2000);
    replies = replies.concat(r1, r2);
  }
  console.log(`\n==== ${replies.length} 个回包（4 变体合计） ====`);
  for (const x of replies) console.log(`  ${x.from}  ${x.len}B`);
  console.log('\n判读：报告灯在①②③④哪一步变色、最终什么颜色——即颜色键号的归因结果');
}

// ---- App 同款成对发送（2026-10-23 lan-diff.pcap 逐字节 diff 定案）----
// App 真实行为：SrcTransNo 会话内小整数严格 +1（观测 400→401→402→403），
// 顺序 = 先 0x02940000 状态包 后 0x059b0000 重置包（间隔 ~2μs 背靠背），
// DstTransNo=0xffffffff、SrcPort=55001、CRC-16/XMODEM（已验证 6/6 匹配）。
// 历史拒收根因：我们用 getSrcTransNo() 随机大数 + 顺序颠倒，设备端重放保护丢弃。
async function pairCmd(bright, cct, startNo) {
  const resetAppend = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]);
  const pktA = buildStatusPacket({ bright, cct, transNo: startNo });
  const pktB = buildStatusPacket({ transNo: startNo + 1, msgType: 0x059b0000, appendOverride: resetAppend });
  console.log(`App 同款成对下发：亮度=${bright}% 色温=${cct}  SrcTransNo=${startNo}(0x02940000) → ${startNo + 1}(0x059b0000)`);
  const replies = await new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const rs = [];
    sock.on('message', (buf, rinfo) => rs.push({ from: `${rinfo.address}:${rinfo.port}`, len: buf.length, hex: buf.toString('hex') }));
    sock.bind(APP_LOCAL_PORT, () => {
      sock.setBroadcast(true);
      sock.send(pktA, APP_LOCAL_PORT, BROADCAST_IP);
      setImmediate(() => sock.send(pktB, APP_LOCAL_PORT, BROADCAST_IP));
      setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(rs); }, 3000);
    });
  });
  console.log(`\n==== ${replies.length} 个回包 ====`);
  for (const r of replies) console.log(`  ${r.from}  ${r.len}B  ${r.hex.slice(0, 100)}`);
  if (!replies.length) console.log('  无回包——关键判据：灯是否真的变亮/变暗到目标值');
  return replies;
}

// ---- 控制器权限宣告 + 控制（2026-10-23 握手机制逆向定案）----
// App 对设备无 Handshake（0x127A0000 仅用于云端测速 testUdpSpeed）。
// 真正的「会话注册」= App 周期广播 199B（0x02020000 ListenLanDevice，Proto=4，
// AppendData 明文不加密——NotLanEcryptMsgType 名单成员），内含设备记录
// {classSku, MAC, deviceId, 控制者IP:端口, 名称16B, ProjectCodeKey aabbcc00/01}。
// 设备收到后把控制者 IP 记为授权会话方 → 后续控制包放行。Mac 从未宣告过 → 全拒。
// 75B 记录布局（真机样本逐字节破译）：000000 | classSku(4B BE) | 0003 | MAC(6B) |
//   00000001 | deviceId(4B BE) | 00000000 | 00000b22 | IP(4B) | d6d9 | 名称(16B) |
//   aabbcc00 | 00000001 | 0043f261 | aabbcc01 | 000005718c00
function buildAnnouncePacket({ macHex, srcIp, deviceIdNum, transNo }) {
  const ipB = (srcIp ?? localLanIp()).split('.').map(Number);
  const u32b = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const ad = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00]),
    Buffer.from([0x29, 0x07, 0x00, 0x03]),          // classSku 0x29070003
    Buffer.from([0x00, 0x03]),
    Buffer.from(macHex.replace(/[:]/g, ''), 'hex'), // 6B MAC
    u32b(1),                                        // 在线状态
    u32b(deviceIdNum),                              // deviceId
    u32b(0),
    Buffer.from([0x00, 0x00, 0x0b, 0x22]),
    Buffer.from(ipB), u32b(APP_LOCAL_PORT).subarray(2), // IP 4B + 端口 2B (55001=d6d9)
    Buffer.from('Digt_6998'.split('').flatMap((c) => [...Buffer.from(c, 'latin1')])), // 9B 名称
    Buffer.alloc(7),                                // 名称补零至 16B
    Buffer.from([0xaa, 0xbb, 0xcc, 0x00]),
    u32b(1),
    Buffer.from([0x00, 0x43, 0xf2, 0x61]),
    Buffer.from([0xaa, 0xbb, 0xcc, 0x01]),
    Buffer.from([0x00, 0x00, 0x05, 0x71, 0x8c, 0x00]),
  ]);
  const msgLen = 24 + ad.length;                    // 99
  const head = Buffer.concat([
    // OppleLink 20B（DstIP=子网广播 192.168.0.255，与 App 一致）
    Buffer.from(ipB), u32b(APP_LOCAL_PORT),
    Buffer.from([0xc0, 0xa8, 0x00, 0xff]), u32b(APP_LOCAL_PORT),
    u32b(1010),
    // OppleNetwork 80B
    u32b(10101), u32b(0), u32b(104 + ad.length), u32b(1), u32b(2), u32b(3),
    u32b(4),                                        // Proto=4（Type4，App 199B 实测值）
    u32b(5),                                        // L3ChkSum
    u32b(0), u32b(0), u32b(deviceIdNum), u32b(0), u32b(0), u32b(0),
    u32b(1), u32b(1), u32b(deviceIdNum), u32b(0), u32b(0), u32b(0),
    // OppleSession 16B（DstTransNo=SrcTransNo 回显，getPduPacketData 默认逻辑）
    u32b(transNo), u32b(transNo), u32b(msgLen), u32b(0),
    // OppleAppHead 8B
    u32b(0x02020000), u32b(0),
  ]);
  const crc = calcCRC(Buffer.concat([head.subarray(100), ad])); // 明文 CRC
  head.writeUInt32BE(crc, 112);
  return Buffer.concat([head, ad]);                 // 数据区不加密
}

async function announceCmd(bright, cct, startNo, bindIp) {
  // MAC 凭证 = HAR DeviceSummaryV2 里天境灯绑定记录的 Mac（=配网时手机 MAC）
  // 设备端校验宣告包 MAC 是否匹配绑定关系；IP 用本机（UDP 真实源一致）
  const macHex = '6879c4916998';
  const myIp = bindIp ?? localLanIp();              // --src=0.108 时完整冒充 App
  const pktA = buildAnnouncePacket({ macHex, srcIp: myIp, deviceIdNum: 0x004020a4, transNo: startNo });
  const resetAppend = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]);
  const pktB = buildStatusPacket({ bright, cct, transNo: startNo + 1, srcIp: myIp });
  const pktC = buildStatusPacket({ transNo: startNo + 2, msgType: 0x059b0000, appendOverride: resetAppend, srcIp: myIp });
  console.log(`宣告+控制：announce(${pktA.length}B transNo=${startNo}) → 状态(${startNo + 1}) → 重置(${startNo + 2})  身份 ${myIp} / ${macHex}${bindIp ? '（IP 冒充）' : ''}`);
  const replies = await new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });
    const rs = [];
    sock.on('message', (buf, rinfo) => rs.push({ from: `${rinfo.address}:${rinfo.port}`, len: buf.length, hex: buf.toString('hex') }));
    sock.bind({ address: bindIp ?? '0.0.0.0', port: APP_LOCAL_PORT }, () => {
      sock.setBroadcast(true);
      sock.send(pktA, APP_LOCAL_PORT, '192.168.0.255');
      sock.send(pktA, APP_LOCAL_PORT, BROADCAST_IP);
      setTimeout(() => sock.send(pktB, APP_LOCAL_PORT, BROADCAST_IP), 50);
      setTimeout(() => sock.send(pktC, APP_LOCAL_PORT, BROADCAST_IP), 80);
      setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(rs); }, 3000);
    });
  });
  console.log(`\n==== ${replies.length} 个回包 ====`);
  for (const r of replies) console.log(`  ${r.from}  ${r.len}B  ${r.hex.slice(0, 100)}`);
  console.log('\n判据：灯是否变到目标亮温（非回包）');
}

// ---- 单设备单控包（2026-10-23 逆向：getDeviceControl@556602 + sendDeviceControl@554920
//      + LanControlAppendData@571267）----
// App 调灯效参数（速度/方向）走此通道：LAN UDP 单播网关，网关再经 BLE SigMesh 转发给灯带。
// 与全状态包差异：DstIP=网关 IP（非广播）、DstObjectID0=目标设备 deviceId、DstTransNo=0、
// 加密 key=网关 MAC hex 派生（非 UniversalKey）、AppendData=纯值序列（按能力表 KeyId 顺序
// 依 ParaType 转字节，无键号头——U8 逐字节 / HexString 原样 hex 解码）。
const u32b = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

function buildUnicastPacket({ gwIp, gwMac, dstDeviceId, msgType, appendHex, ucloudId, srcIp, transNo }) {
  const ipB = (srcIp ?? localLanIp()).split('.').map(Number);
  const gwB = gwIp.split('.').map(Number);
  const append = Buffer.from(appendHex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  const msgLen = 24 + append.length;
  const head = Buffer.concat([
    // OppleLink 20B
    Buffer.from(ipB), u32b(APP_LOCAL_PORT),
    Buffer.from(gwB), u32b(55001),
    u32b(1010),
    // OppleNetwork 80B
    u32b(10101),            // L3Version
    u32b(0),                // ServType
    u32b(104 + append.length), // DataPkgLen
    u32b(1),                // L3Id
    u32b(2),                // Offset
    u32b(3),                // Ttl
    u32b(3),                // Proto = UniversalXor
    u32b(5),                // L3ChkSum
    u32b(0),                // SrcServiceFlag
    u32b(0),                // SrcObjectType
    u32b(ucloudId),         // SrcObjectID0 = uCloudId（App 登录态）
    u32b(0), u32b(0), u32b(0),
    u32b(0),                // DstServiceFlag
    u32b(1),                // DstObjectType
    u32b(dstDeviceId),      // DstObjectID0 = 目标设备真实 deviceId（BLE 设备也填自身，网关代转发）
    u32b(0), u32b(0), u32b(0),
    // OppleSession 16B
    u32b(transNo ?? getSrcTransNo()), // SrcTransNo
    u32b(0),                // DstTransNo（单播=0）
    u32b(msgLen),
    u32b(0),                // CheckSum 占位
    // OppleAppHead 8B
    u32b(msgType),          // 业务命令字直接做 MsgType
    u32b(0),                // Reserve
  ]);
  const crc = calcCRC(Buffer.concat([head.subarray(100), append]));
  head.writeUInt32BE(crc, 112);
  const key = generatePasswordKey(gwMac);
  const enc = Buffer.from(append);
  for (let i = 0; i < enc.length; i++) enc[i] ^= key[i % 20];
  return Buffer.concat([head, enc]);
}

function sendUnicast(pkt, gwIp, port = 55001, waitMs = 2000) {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const replies = [];
    sock.on('message', (buf, rinfo) => replies.push({ from: `${rinfo.address}:${rinfo.port}`, len: buf.length, hex: buf.toString('hex') }));
    sock.bind(() => {
      sock.send(pkt, port, gwIp);
      console.log(`  → 单播 ${gwIp}:${port}  包 ${pkt.length}B  本机身份 ${localLanIp()}`);
      console.log(`  hex: ${pkt.toString('hex')}`);
      setTimeout(() => { try { sock.close(); } catch { /* noop */ } resolve(replies); }, waitMs);
    });
  });
}

// 灯带跑马单控：AppendData = U8(回路0) U8(模式1) hex(红蓝双色CXCY) U8(速度) U8(方向)
const STRIP_DEVICE_ID = 4212993;          // 2122018 电视机灯带真实 deviceId（HAR DeviceSummaryV2）
const GATEWAY = { ip: '192.168.0.119', mac: '142B2FB08BC8', deviceId: 2626951 }; // 客厅网关（HAR DeviceSummaryV2 权威）
const UCLOUD_ID = 4202639;                // App 登录态 ucloundid（HAR）
const STRIP_COLOR = '19000CE405DC0258';   // 红蓝双色 CXCY

async function speedCmd(speed, direction = 0) {
  const append = '0001' + STRIP_COLOR + (speed & 0xff).toString(16).padStart(2, '0') + (direction & 0xff).toString(16).padStart(2, '0');
  const pkt = buildUnicastPacket({
    gwIp: GATEWAY.ip, gwMac: GATEWAY.mac, dstDeviceId: STRIP_DEVICE_ID,
    msgType: 0x14050000, appendHex: append, ucloudId: UCLOUD_ID,
  });
  console.log(`下发跑马单控：速度=${speed} 方向=${direction}  AppendData=${append}（${append.length / 2}B）`);
  const replies = await sendUnicast(pkt, GATEWAY.ip);
  console.log(`\n==== ${replies.length} 个回包 ====`);
  for (const r of replies) console.log(`  ${r.from}  ${r.len}B  ${r.hex}`);
  if (!replies.length) console.log('  无回包——观察灯带流速是否变化，并配合 GetDeviceStatus 读 0x1E0E 验证');
}

// 通用单控：任意命令字 + 手工 AppendData hex
async function msgCmd(msgTypeHex, dstId, appendHex) {
  const msgType = parseInt(msgTypeHex, 16);
  if (!Number.isFinite(msgType) || !dstId || !appendHex) {
    console.error('用法: msg <hexMsgType> <dstDeviceId> <appendHex>'); process.exit(1);
  }
  const pkt = buildUnicastPacket({
    gwIp: GATEWAY.ip, gwMac: GATEWAY.mac, dstDeviceId: Number(dstId),
    msgType, appendHex, ucloudId: UCLOUD_ID,
  });
  console.log(`下发通用单控：msgType=${msgTypeHex} dst=${dstId} append=${appendHex}`);
  const replies = await sendUnicast(pkt, GATEWAY.ip);
  console.log(`\n==== ${replies.length} 个回包 ====`);
  for (const r of replies) console.log(`  ${r.from}  ${r.len}B  ${r.hex}`);
}

// ---- CLI 分发 ----
const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: {
    ucloudid: { type: 'string', default: '1' },
    dport: { type: 'string', default: '65501' },
    timeout: { type: 'string', default: '300' },
    src: { type: 'string' },   // 冒充源 IP（需先 sudo ifconfig en0 alias <ip>/32）
  },
});
const common = {
  ucloudid: Number(opts.ucloudid),
  dport: Number(opts.dport),
  timeout: Number(opts.timeout),
};
const [cmd, a1, a2] = positionals;
const a3 = positionals[3];

switch (cmd) {
  case 'color':
    if (!a1 || !CIE[a1]) { console.error('用法: color <red|green|blue>'); process.exit(1); }
    await colorCmd();
    break;
  case 'cct':
    if (!a1) { console.error('用法: cct <色温 0-10000> [亮度 0-100]'); process.exit(1); }
    await cctCmd(Number(a1), a2 === undefined ? undefined : Number(a2));
    break;
  case 'discover':
    discover(Number(a1) || 10);
    break;
  case 'control':
    if (!a1 || !a2) { console.error('用法: control <ip|devId> <on|off>'); process.exit(1); }
    await controlCmd(a1, a2, common);
    break;
  case 'authtest':
    if (!a1 || !a2) { console.error('用法: authtest <ip|devId> <on|off>'); process.exit(1); }
    console.log('=== 第 1 发：真实 uCloudId ===');
    const r1 = await controlCmd(a1, a2, common);
    await new Promise((r) => setTimeout(r, 800));
    console.log('=== 第 2 发：错误 uCloudId（+1） ===');
    const r2 = await controlCmd(a1, a2, common, { fakeId: true });
    console.log('\n==== 校验强度结论 ====');
    if (r1.ok && r2.ok) console.log('两次均生效 → 设备端不校验 uCloudId，纯同网段信任（token/凭证完全不需要）');
    else if (r1.ok && !r2.ok) console.log('仅真实 uCloudId 生效 → 设备端校验绑定关系，但 uCloudId 一次抓包即可获得（静态值）');
    else console.log('真实 uCloudId 也无响应 → PDU 布局或加密推测需按 discover 回包校准');
    break;
  case 'announce':
    if (!a1 || !a2 || !a3) { console.error('用法: announce <亮度> <色温> <SrcTransNo起值>'); process.exit(1); }
    await announceCmd(Number(a1), Number(a2), Number(a3), opts.src);
    break;
  case 'pair':
    if (!a1 || !a2 || !a3) { console.error('用法: pair <亮度0-100> <色温0-10000> <SrcTransNo起值>'); process.exit(1); }
    await pairCmd(Number(a1), Number(a2), Number(a3));
    break;
  case 'speed':
    if (!a1) { console.error('用法: speed <1-100> [方向0|1]'); process.exit(1); }
    await speedCmd(Number(a1), a2 === undefined ? 0 : Number(a2));
    break;
  case 'msg':
    if (!a1 || !a2 || !positionals[3]) { console.error('用法: msg <hexMsgType> <dstDeviceId> <appendHex>'); process.exit(1); }
    await msgCmd(a1, a2, positionals[3]);
    break;
  default:
    console.log(`欧享家 UDP 直控探测
  node tools/udp-probe.js pair <亮度> <色温> <SrcTransNo>  # App 同款成对包（状态→重置，计数器接续）
  node tools/udp-probe.js speed <1-100> [方向0|1]          # 跑马速度单控（单播网关→BLE 灯带，App 同款通道）
  node tools/udp-probe.js msg <hexMsgType> <devId> <hex>   # 通用单控（任意命令字+手工 AppendData）
  node tools/udp-probe.js cct <色温0-10000> [亮度0-100]   # 全状态控制包（App 模板校准版）
  node tools/udp-probe.js color <red|green|blue>          # 颜色键号归因实验（4 变体连发）
  node tools/udp-probe.js discover [秒=10]
  node tools/udp-probe.js control <ip> <on|off>   [--ucloudid=N] [--dport=65501] [--timeout=300]
  node tools/udp-probe.js authtest <ip> <on|off>  （真/假 uCloudId 对照，验证设备校验强度）`);
}
