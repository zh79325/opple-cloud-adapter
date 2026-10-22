#!/usr/bin/env node
// 欧享家 UDP 抓包解析器：读 pcap → 剥链路/IP/UDP 头 → 解析 PDU 结构 → 同长度包 diff →
// 尾部数据区多相位 XOR 解密尝试。用于从 App 真实控制包校准 buildPdu() 布局。
//
// 用法：
//   node tools/udp-parse.js /tmp/opple-udp2.pcap            # 全量解析 + 同长度 diff + 解密尝试
//   node tools/udp-parse.js /tmp/opple-udp2.pcap 176        # 只看指定应用层长度的包
//
// 依赖系统 tcpdump（只读 pcap，不需要 sudo）。

import { spawnSync } from 'node:child_process';

const XOR_KEY = new TextEncoder().encode('qazedcwsx1ujmyhntgb9'); // OPUniversalKey（20 字节）

// ---- pcap → 应用层字节数组列表 ----
function readPcap(file) {
  const r = spawnSync('tcpdump', ['-r', file, '-nn', '-xx'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) throw new Error(`tcpdump 读取失败: ${r.stderr}`);
  const pkts = [];
  let stamp = '';
  for (const line of r.stdout.split('\n')) {
    if (/^\d+-\d+-\d+|^\d+:\d+:\d+/.test(line)) stamp = line.trim();
    const m = line.match(/^\s+0x([0-9a-f]+):\s+(.+)$/);
    if (!m) continue;
    const hexPart = m[2].replace(/\s+/g, '').slice(0, 32); // 每行最多 16 字节
    const off = parseInt(m[1], 16);
    let p = pkts[pkts.length - 1];
    if (!p || p.next !== off) { pkts.push({ stamp, bytes: [], next: off }); p = pkts[pkts.length - 1]; }
    for (let i = 0; i < hexPart.length; i += 2) p.bytes.push(parseInt(hexPart.slice(i, i + 2), 16));
    p.next = off + hexPart.length / 2;
    p.stamp = stamp;
  }
  // 每包剥 14B 以太网 + IP 头(20B, IHL) + UDP 头(8B)
  return pkts.map((p) => {
    const b = p.bytes;
    const ipStart = 14;
    const ihl = (b[ipStart] & 0x0f) * 4;
    const appStart = ipStart + ihl + 8;
    const src = `${b[ipStart + 12]}.${b[ipStart + 13]}.${b[ipStart + 14]}.${b[ipStart + 15]}`;
    const dst = `${b[ipStart + 16]}.${b[ipStart + 17]}.${b[ipStart + 18]}.${b[ipStart + 19]}`;
    const sport = (b[ipStart + ihl] << 8) | b[ipStart + ihl + 1];
    const dport = (b[ipStart + ihl + 2] << 8) | b[ipStart + ihl + 3];
    return {
      stamp: p.stamp, src, dst, sport, dport,
      app: Buffer.from(b.slice(appStart)),
    };
  });
}

// ---- 结构解析（基于 2026-10-22 三组真机包对照的布局 v2）----
function parseApp(app) {
  const u16 = (o) => app.readUInt16BE(o);
  const u32 = (o) => app.readUInt32BE(o);
  const ip = (o) => [...app.subarray(o, o + 4)].join('.');
  const r = {
    len: app.length,
    srcIp: ip(0), srcPort: u32(4), dstIp: ip(8), dstPort: u32(12),
    l2Type: u16(18),                       // 1010=0x03F2
    tag22: u16(20),                        // 2775 常量?
    innerLen: u16(30),                     // = len - 20
    channels: [],                          // @32 起 6×U32 通道数组
    sessionId: '-',
    seq: '-', dstId: '-', dataLen: '-', transNo: '-', cmd: '-',
  };
  for (let i = 0; i < 6; i++) r.channels.push(u32(32 + i * 4));
  // @56..102 区域：0x004020a4 等 ID 记录，逐包可能不同，取原样 hex
  r.mid = app.subarray(56, 96).toString('hex');
  r.seq = u16(96);                        // 观测: 0c→15→cf 递增
  r.dstId = u32(98) === 0xffffffff ? '-1(广播)' : String(u32(98));
  r.dataLen = u32(102);
  r.transNo = u32(106);
  r.cmd = u16(110);                       // 观测: 0294(色温组) / 059b(短包)
  // 数据区起点探测：dataLen 与 len 的关系不定，从 112 起视为尾部
  r.tail = app.subarray(112).toString('hex');
  return r;
}

// ---- 尾部多相位 XOR 解密尝试 ----
function tryDecrypt(app) {
  const outs = [];
  const starts = [112, 116, 120, 124, 128]; // 数据区起点假设（含 encryptLanData@124 逆向值）
  for (const s of starts) {
    if (s >= app.length) continue;
    const out = Buffer.from(app.subarray(s));
    for (let i = 0; i < out.length; i++) out[i] ^= XOR_KEY[i % 20];
    outs.push(`    start=${s}: ${out.toString('hex')}  |${out.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}|`);
  }
  return outs;
}

// ---- 同长度包逐字节 diff ----
function diffGroups(pkts, filter) {
  const groups = new Map();
  for (const p of pkts.filter(filter)) {
    if (!groups.has(p.app.length)) groups.set(p.app.length, []);
    groups.get(p.app.length).push(p);
  }
  for (const [len, list] of groups) {
    if (list.length < 2) continue;
    console.log(`\n――― 同长度(${len}B) × ${list.length} 包逐字节 diff（变化字节用 ^^ 标出）―――`);
    const base = list[0].app;
    for (const p of list.slice(1)) {
      const marks = [...base].map((v, i) => (p.app[i] !== v ? '^^' : '  ').slice(0, 2)).join('');
      console.log(`  ${p.src} → ${p.dst}  ${p.stamp}`);
      console.log(`  hex : ${p.app.toString('hex')}`);
      console.log(`  diff: ${marks}`);
    }
  }
}

// ---- 主流程 ----
const [file, lenFilter] = process.argv.slice(2);
if (!file) { console.error('用法: node tools/udp-parse.js <pcap> [应用层长度过滤]'); process.exit(1); }
const all = readPcap(file);
console.log(`共 ${all.length} 包（tcpdump 只读，无需 sudo）`);
const pkts = lenFilter ? all.filter((p) => p.app.length === Number(lenFilter)) : all;

for (const p of pkts) {
  const a = parseApp(p.app);
  console.log(`\n━━ ${p.stamp}\n  ${p.src}:${p.sport} → ${p.dst}:${p.dport}  应用层 ${a.len}B`);
  console.log(`  SrcIP=${a.srcIp} SrcPort=${a.srcPort} DstIP=${a.dstIp} DstPort=${a.dstPort}`);
  console.log(`  L2Type=${a.l2Type} tag22=0x${a.tag22.toString(16)} innerLen=${a.innerLen}`);
  console.log(`  channels=[${a.channels.join(', ')}]`);
  console.log(`  mid(@56..96)=${a.mid}`);
  console.log(`  seq=${a.seq} dstId=${a.dstId} dataLen=${a.dataLen} transNo=0x${(a.transNo >>> 0).toString(16)} cmd=0x${a.cmd.toString(16)}`);
  console.log(`  tail(@112..)=${a.tail}`);
  console.log(`  尾部 XOR 解密尝试:`);
  for (const line of tryDecrypt(p.app)) console.log(line);
}

diffGroups(pkts, () => true);
console.log('\n提示：diff 中恒定的密文段 = 恒定明文（ID 类字段）；变化的字节即候选值字段，');
console.log('用「色温极差实验」（最暖↔最冷多次）抓值域后即可定案值编码。');
