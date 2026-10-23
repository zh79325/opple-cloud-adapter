#!/usr/bin/env node
// udp-verify.js —— exp2 实验闭环：云端状态前后对照，自动判定 LAN UDP 控制是否生效
// 用法: node tools/udp-verify.js [目标亮度%] [色温K] [TransNo]
import { getClient } from '../src/cli.js';
import { execFileSync } from 'node:child_process';

const VDEV = Number(process.env.VDEV ?? 2122050); // 天境灯（客厅灯）；书房灯终局实验用 VDEV=2112352 node tools/udp-verify.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot(tag) {
  const c = getClient();
  const { status } = await c.deviceStatus(VDEV);
  const get = (t) => status.find((s) => s.StatusType === t)?.Value;
  const snap = {
    tag, 开关: get('0x0208'), 灯具开关: get('0x0207'),
    亮度: get('0x0300'), 色温: get('0x0301') ?? get('0x031b'),
  };
  console.log(`[${tag}]`, JSON.stringify(snap));
  return snap;
}

const [brightArg, cctArg, transArg] = process.argv.slice(2);
const bright = brightArg ?? '5';
const cct = cctArg ?? '3000';
const transNo = transArg ?? '60';

const before = await snapshot('实验前');
console.log(`\n>>> 跑 exp2（0x0397 探针×2 + 同字节×4 + 对照×1，目标亮度 ${bright}%）…\n`);
execFileSync('node', ['tools/udp-probe.js', 'exp2', bright, cct, transNo, ...(process.env.DST ? [process.env.DST] : [])], { stdio: 'inherit' });
await sleep(4000);
const after = await snapshot('实验后');

const changed = Number(after.亮度) !== Number(before.亮度);
console.log('\n==== 判定 ====');
console.log(`亮度 ${before.亮度} → ${after.亮度}  ${changed ? '★ LAN 控制生效！' : 'LAN 控制未生效（灯无响应，包未进业务层）'}`);
if (changed) {
  console.log('>>> 恢复原状态（云端通道）…');
  const c = getClient();
  if (Number(before.亮度) === 0) await c.callAction(VDEV, '0x03110000', [0]);
  else await c.callAction(VDEV, '0x03130000', [Number(before.亮度)]);
  await sleep(1500);
  await snapshot('恢复后');
}
