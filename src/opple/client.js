// 欧享家云端 API 客户端（零依赖，基于逆向报告 docs/reverse-engineering-report.md）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const CONFIG_PATH = join(homedir(), '.opple-cli.json');

const DEFAULT_BASE = 'https://iot2.opple.com';
const CLIENT_ID = 'opple_smarthome';
const APP_VERSION = '5.8.0';

export class OppleClient {
  /**
   * @param {{token:string, projectCode:string, base?:string}} opts
   */
  constructor(opts) {
    this.token = opts.token;
    this.projectCode = opts.projectCode;
    this.base = opts.base ?? DEFAULT_BASE;
    this.tid = randomUUID();
  }

  static loadConfig() {
    if (!existsSync(CONFIG_PATH)) {
      throw new Error(`未找到配置文件 ${CONFIG_PATH}，先用 "opple token save <token> <projectCode>" 保存`);
    }
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return new OppleClient(cfg);
  }

  saveConfig() {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      token: this.token,
      projectCode: this.projectCode,
      base: this.base,
    }, null, 2));
    return CONFIG_PATH;
  }

  headers() {
    return {
      'Lang': 'zh-cn',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'App-TimeZone': 'Asia/Shanghai',
      'App-TimeZone-Offset': '+480',
      'App-Version': APP_VERSION,
      'ClientId': CLIENT_ID,
      'clientid': CLIENT_ID, // iOS 端小写形式，服务端不区分
      'OSType': 'IOS',
      'ProjectCode': this.projectCode,
      'Projectcode': this.projectCode,
      'projectcode': this.projectCode,
      'Token': this.token,
      'token': this.token,
      'tid': this.tid,
      'client-up-time': String(Date.now()),
      'User-Agent': 'SmartHome/3 CFNetwork/3896.100.1.2.1 Darwin/27.0.0',
    };
  }

  /**
   * 发起请求。GET/POST 均走 App 同款鉴权头。
   * @param {string} method
   * @param {string} path
   * @param {object} [query] - query 参数（拼到 URL）
   * @param {object} [body] - POST JSON body
   */
  async request(method, path, { query, body } = {}) {
    let url = `${this.base}${path}`;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      url += `?${qs.toString()}`;
    }
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: method === 'POST' && body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 200) {
      throw new Error(`HTTP ${res.status} ${method} ${path}`);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`响应非 JSON: ${text.slice(0, 200)}`); }
    // 统一错误处理：StatusCode !== 0 视为失败
    if (json.StatusCode !== undefined && json.StatusCode !== 0) {
      throw new Error(`[${json.StatusCode}] ${json.Message ?? '未知错误'} (${path})`);
    }
    return json.Result ?? json;
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, query) { return this.request('POST', path, { body, query }); }

  // ---------- 业务接口 ----------

  /** 校验/刷新 token */
  async checkToken() {
    // 该接口返回 {"Result":true,"StatusCode":0}，无 Result 载荷
    const url = `${this.base}/api/User/CheckAndRefreshToken?token=${this.token}`;
    const res = await fetch(url, { headers: this.headers() });
    const json = await res.json();
    return json;
  }

  /** 设备列表（分页全量；gpNo 指定房间时返回该房间设备） */
  async listDevices(gpNo = -1) {
    // App 首次拉取用 gpNo=-1 childCategoryType=1（仅网关/根设备）；指定房间 Gpno 时返回房间全部设备
    const all = [];
    let pageIndex = 1;
    for (;;) {
      const page = await this.get('/api/Device/FindDeviceListByPage', {
        gpNo, childCategoryType: 1, PageIndex: pageIndex, PageSize: 100,
      });
      const list = page?.RecordList ?? [];
      all.push(...list);
      if (pageIndex >= (page?.PageCount ?? 1)) break;
      pageIndex++;
    }
    return all;
  }

  /** 设备摘要（轻量列表：名称/ID/房间/在线） */
  async deviceSummary() {
    return this.get('/api/Device/DeviceSummaryV2', { t: Date.now() });
  }

  /** 查询设备可用动作（统一模型的"动作"来源） */
  async actionAbility(vDeviceId) {
    return this.get('/api/Device/FindActionAbilityByVDeviceId', { vDeviceId, t: Date.now() });
  }

  /** 调用设备动作（核心控制指令） */
  async callAction(params) {
    return this.get('/api/Device/CallAction', params);
  }

  /** 家庭列表 */
  async homeList() {
    const r = await this.get('/api/Project/GetHomeList', { inviteStatus: '0,1,3', pageIndex: 1, pageSize: 8888 });
    return r?.RecordList ?? r;
  }

  /**
   * 家庭 → 房间 → 设备 三层树。
   * 房间通过 gpNo 逐级下钻（App 用 childCategoryType=2 查子设备）。
   */
  async tree() {
    const homes = await this.homeList();
    const out = [];
    for (const home of homes) {
      if (home.IsArchive) continue;
      // 切换到该家庭的 projectcode 上下文
      const saved = this.projectCode;
      this.projectCode = home.ProjectCode;
      try {
        // 房间列表（version=2 返回 Gpno/GpName/DeviceCount/Childs）
        const rooms = await this.get('/businessapi/Room/FindUserRoomList', { version: 2 }).catch(() => []);
        const roomList = Array.isArray(rooms) ? rooms : [];
        // 每个房间下钻设备（gpNo=房间 Gpno，childCategoryType=1 含子设备）
        const roomsOut = [];
        for (const room of roomList) {
          const devices = await this.listDevices(room.Gpno).catch(() => []);
          roomsOut.push({
            gpno: room.Gpno,
            name: room.GpName ?? room.Name,
            deviceCount: room.DeviceCount,
            devices: devices.map(d => ({
              vDeviceId: d.VDeviceId,
              name: d.DeviceName,
              type: d.ClassSkuName ?? d.ClassSku,
              protocol: d.ProtocolTypeName,
              online: d.IsOnline,
              parent: d.ParentVDeviceId ?? null,
            })),
          });
        }
        out.push({
          projectCode: home.ProjectCode,
          name: home.ProjectName,
          deviceCount: home.DeviceCount,
          onlineCount: home.OnlineCount ?? null,
          rooms: roomsOut,
        });
      } finally {
        this.projectCode = saved;
      }
    }
    return out;
  }
}
