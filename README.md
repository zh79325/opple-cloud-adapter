# opple-cli — 欧享家（欧普 INNO 生态）本地终端

零依赖（Node 22+）的命令行工具，通过欧享家云端 API 控制 INNO 网关、天境吸顶灯、SDL/双色灯带等欧普设备。协议细节见 `docs/reverse-engineering-report.md`。

## 快速开始

```bash
# 1. 安装（全局可用 opple 命令）
cd ~/Desktop/github/opple-cloud-adapter
npm link

# 2. 保存凭据（token 从抓包获取，见下文）
opple token save <32位token> <projectCode>

# 3. 使用
opple homes                       # 家庭列表
opple devices                     # 全部设备（ID/房间/在线状态）
opple actions 2112849             # 查询某设备可用动作
opple call 2112849 <actionId> k=v # 控制设备
opple raw GET /api/Project/GetHomeList   # 调试任意接口
```

## 如何获取 token

用 Reqable 抓包（流程见项目文档），从任意 `iot2.opple.com` 请求的 `token` 请求头取 32 位 hex 值，`projectcode` 同理（如 356748）。token 会随 `CheckAndRefreshToken` 轮换，App 重新登录后旧 token 失效。

> 目前登录接口（`/baseservice/User/LoginOrRegisterByCode` 验证码登录）的请求体结构待补抓包确认，确认后即可实现 CLI 内直接登录，摆脱手工抓 token。

## 命令一览

| 命令 | 说明 |
|---|---|
| `token save/check` | 保存/校验凭据 |
| `homes` | 家庭列表 |
| `devices` | 设备列表（分页全量） |
| `actions <vDeviceId>` | 设备可用动作枚举（统一模型"动作"来源） |
| `call <vDeviceId> <actionId> [k=v…]` | 调用动作（核心控制） |
| `raw <METHOD> <path> [jsonQuery]` | 任意接口调试 |

## 已验证

- 请求头构造与 App 一致（ClientId/Token/ProjectCode/App-TimeZone 等）
- 服务端返回标准业务错误码（12004 token 过期、10001 参数错误），证明协议链路完全联通
- 532 个接口路径清单在 `data/api_paths.txt`

## 后续规划

1. 登录接口实现（补抓包后）
2. `actions` 结构化展示（表格化 action 枚举）
3. socket.io 实时状态订阅（`wss://iot2.opple.com/socket.io/`）
4. 统一设备模型适配层（对接 smart-home 总控项目）
