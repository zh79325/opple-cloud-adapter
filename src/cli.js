// CLI 命令分发与实现
import { OppleClient } from './opple/client.js';

const HELP = `opple — 欧享家（欧普 INNO）本地终端控制

用法: opple <命令> [参数]

命令:
  token save <token> <projectCode>   保存凭据到 ~/.opple-cli.json
  token check                        校验/刷新 token
  homes                              家庭列表
  devices                            设备列表（含房间、在线状态、品类）
  actions <vDeviceId>                查询某设备可用动作
  call <vDeviceId> <actionId> [k=v…] 调用设备动作
    例: opple call 2112849 1 value=1
  raw <METHOD> <path> [jsonQuery]    直接调用任意接口（调试用）
    例: opple raw GET /api/Project/GetHomeList
        opple raw POST /api/Device/GetDeviceCount {}

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

  if (cmd === 'devices') {
    const c = getClient();
    const devices = await c.listDevices();
    const rows = devices.map(d => [
      d.VDeviceId, d.DeviceName, d.AreaName ?? '-', d.ClassSkuName ?? d.ClassSku,
      d.IsOnline ? '在线' : '离线', d.ParentVDeviceId ?? '-',
    ]);
    printTable(rows, ['VDeviceId', '名称', '房间', '品类', '状态', '父设备']);
    console.log(`\n共 ${devices.length} 台设备`);
    return;
  }

  if (cmd === 'actions') {
    const vDeviceId = rest[0];
    if (!vDeviceId) throw new Error('用法: opple actions <vDeviceId>');
    const c = getClient();
    const ability = await c.actionAbility(vDeviceId);
    console.log(JSON.stringify(ability, null, 2));
    return;
  }

  if (cmd === 'call') {
    const [vDeviceId, actionId, ...kvPairs] = rest;
    if (!vDeviceId || !actionId) throw new Error('用法: opple call <vDeviceId> <actionId> [k=v …]');
    const params = { vDeviceId, actionId };
    for (const kv of kvPairs) {
      const [k, v] = kv.split('=');
      if (!k) continue;
      // 数字自动转型，布尔识别
      params[k] = v === 'true' ? true : v === 'false' ? false : /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    const c = getClient();
    const r = await c.callAction(params);
    console.log(JSON.stringify(r ?? { ok: true }, null, 2));
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
