#!/usr/bin/env node
// lan-sweep.js —— 全屋单播发现：对 192.168.0.2-254 的 55001/55002 发 SearchDevice_req
// （v1 布局已证实可触发应答），建立「IP:端口 ↔ 设备」地图。
// 用法: node tools/lan-sweep.js [秒=10]
import { createSocket } from 'node:dgram';

const XOR_KEY = new TextEncoder().encode('qazedcwsx1ujmyhntgb9');
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

function buildDiscoverReq() {
  const head = Buffer.concat([
    u16(1010), u8(1), u32(0x02010000), u32(0), u32(0),
    u8(0), u8(0), u32(0), u8(0), u8(1), u32(0),
  ]);
  const pdu = Buffer.alloc(100, 0);
  head.copy(pdu, 0);
  for (let i = 100; i < 124; i++) pdu[i] ^= XOR_KEY[(i - 100) % 20];
  return pdu;
}

const seconds = Number(process.argv[2] ?? 10);
const sock = createSocket({ type: 'udp4', reuseAddr: true });
const found = new Map();
sock.on('message', (buf, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  if (found.has(key)) return;
  const raw = buf.toString('hex');
  found.set(key, { ip: rinfo.address, port: rinfo.port, len: buf.length, hex: raw });
  console.log(`✦ ${key}  ${buf.length}B`);
  console.log(`   ${raw.slice(0, 160)}`);
});

const req = buildDiscoverReq();
const targets = [];
for (let i = 2; i <= 254; i++) { targets.push([55001, `192.168.0.${i}`]); targets.push([55002, `192.168.0.${i}`]); }

sock.bind(55001, () => {
  sock.setBroadcast(true);
  console.log(`全屋扫描 ${targets.length} 个目标（${seconds}s）...`);
  // 分批慢速发，避免路由器限速丢包
  let idx = 0;
  const batch = setInterval(() => {
    for (let k = 0; k < 40 && idx < targets.length; k++, idx++) {
      const [port, ip] = targets[idx];
      sock.send(req, port, ip);
    }
    if (idx >= targets.length) clearInterval(batch);
  }, 150);
  setTimeout(() => {
    clearInterval(batch);
    sock.close();
    console.log(`\n==== 应答 ${found.size} 个 ====`);
    for (const [k, v] of found) {
      // 提取记录区 deviceId 候选（回包里 002815da 形态的 u32）
      const ids = [...new Set([...v.hex.matchAll(/002815da|004020a4|0020[0-9a-f]{4}/g)])].map((m) => m[0]);
      console.log(`  ${k}  len=${v.len}  deviceId候选=[${ids.join(',') || '-'}]`);
    }
  }, seconds * 1000);
});
