# 欧享家（com.opple.smarthome）5.8.0 逆向分析报告

> 分析日期：2026-10-22
> 样本：opple_smarthome_5.8.0.apk（MD5: 143989986ffca81ce586f8c1b6a84f48，与官方发布一致）
> 工具链：REA (rea-agents v6.7.0) + apktool 3.0.3 + hbc-decompiler (hermes-dec 0.1.8)
> 交叉验证：iOS 端 Reqable 抓包（248 条请求，201 条为 iot2.opple.com）

## 1. App 架构结论

- **React Native + Hermes**：业务逻辑全部在 `assets/index.android.bundle`（Hermes 字节码 v96，20MB），网络层、签名逻辑均为 JS 实现——比 dex 反编译容易得多。
- **无加固、无壳**：6 个标准 classes.dex 可直接分析；ProGuard 混淆不影响 JS 层。
- Hermes 字节码 v96 太新，hbctool 不支持；用 `hbc-decompiler` 成功恢复出 99MB 可读 JS（寄存器风格伪代码，函数原始名保留）。

## 2. 云端 API 架构（已与抓包互相印证）

| 项 | 值 |
|---|---|
| 主 API 域名 | `https://iot2.opple.com` |
| 私有/控制通道 | `https://iotctrl.opple.com`（端口 65501 见 OPIOTIPPort） |
| 事件日志 | `https://opsc-qa-public.opple.com`（ELK 上传） |
| 资源 CDN | `https://appresource.opple.com` |
| 实时状态 | `wss://iot2.opple.com/socket.io/?token=xxx&ucloundid=xxx`（socket.io EIO=3） |

## 3. 请求头（appendHeaders 函数，行 214246 起——与抓包完全吻合）

```
Lang: zh-cn
Accept: application/json
Content-Type: application/json
App-TimeZone: Asia/Shanghai
App-TimeZone-Offset: +480
App-Version: 5.8.0
ClientId: opple_smarthome
OSType: Android / IOS
ProjectCode: <当前家庭 projectcode>
Token: <32位hex token>
tid: <UUID>            (BaseHttpFetch 里统一注入)
client-up-time: <毫秒时间戳>
```

抓包中 iOS 的 header 大小写（app-version/ostype/clientid）与 Android 端 PascalCase（App-Version/OSType/ClientId）并存，服务端按大小写不敏感处理（HTTP 语义本身不敏感）。

**关键结论：普通业务接口（设备列表、CallAction 控制指令等）没有任何 sign 签名**——鉴权只靠 Token header + ProjectCode。

## 4. 签名机制（仅两处，均为辅助功能，不做控制用）

### 4.1 事件日志上传（multipartFormDataForEventLog，行 215700 起）
- 签名对象：`{timestamp: 秒级时间戳, appId: 'app'}` + url query 排序拼接
- query 参数按字典序 sort 后用 `&` join，再与 JSON.stringify(sortedParams) 以 `#` 连接
- 算法：`HmacSHA256(data, Hex.parse('5e4e9e2fedb6871c19c8e57d8f31b3b8c9df4bc0e9f91220dfbb3a6c64e1a1b6'))`，取 hex 前 32 字符，与 appId 以 `:` 拼接
- 密钥（硬编码）：`5e4e9e2fedb6871c19c8e57d8f31b3b8c9df4bc0e9f91220dfbb3a6c64e1a1b6`

### 4.2 getNetworkSign（行 250875 起）
- sha256withRSA：`SHA1withRSA` 签名（jsrsasign 库），私钥硬编码在 bundle 内（PEM，行 250873）
- 使用场景：日志/特殊请求，未在主控制链路发现调用

## 5. 登录接口（抓包未捕获，静态分析补齐）

| 接口 | 用途 |
|---|---|
| `POST /baseservice/User/LoginOrRegisterByCode` | 手机验证码登录（主登录） |
| `POST /baseservice/User/OneClickLogin` | 一键登录 |
| `GET /api/User/SendVerifyCode` | 发送验证码 |
| `GET /api/User/CheckAndRefreshToken?token=xxx` | token 刷新（抓包已验证返回 Result:true） |
| `POST /baseservice/Common/CaptchaVerify` | 阿里云滑块验证（抓包出现过） |

## 6. 设备控制指令（核心发现）

**`GET /api/Device/CallAction`** ——所有设备动作统一走这个接口（发现于行 550037）：
- 参数：`vDeviceId` + `msgType`（命令字）+ `channelId=65535` + `values`（按 `FindDeviceAbility` 返回的 `Values[].KeyId` 升序逗号拼接）
- 实测样例（来自 2026-10-22 11:44 抓包）：
  - 开关灯带亮度：`msgType=0x03130000&values=178`
  - 调色温：`msgType=0x031B0000&values=8300`（8300K）
  - 调颜色：`msgType=0x046B0000&values=0,276303529`（回路号,CXCY 打包值）

### 6.1 灯光命令字表（来自 FindDeviceAbility 实测响应）

| msgType | 功能 | 参数范围 |
|---|---|---|
| 0x03110000 | 开关 | 0/1 |
| 0x03130000 | 亮度（无级） | 1-255 |
| 0x031B0000 | 色温（无级，SDL 灯为 1800-12000K） | 开尔文值 |
| 0x14170000 | DUV | -8~8（带回路号前缀） |
| 0x046B0000 | 颜色（CXCY） | 回路,32位打包值 |
| 0x046F0000 | 日光/光模式预设 | 回路,预设枚举值 |
| 0x14190000 | 天际模式（蓝天/晨光/暮霞…） | 回路,模式枚举 |
| 0x03840000 / 0x03880000 | 分级调亮度/调色温 | 步进 |

### 6.2 CXCY 颜色编码（已验证）

32 位打包：**高 16 位 = cx×10000，低 16 位 = cy×10000**。
- 彩光：藤萝紫 207948282 = (0.3173, 0.2554)，竹影绿 242749551 = (0.3704, 0.4207)
- 日光模式预设例外：高 16 位直接放**色温 K**（晨曦=0x0BB8=3000K，明月=0x2710=10000K），低 16 位为附加参数
- CLI 已实现 `#RRGGBB → xy → CXCY` 自动转换（sRGB→XYZ→归一化投影）

### 6.3 悦动灯效命令（灯带类设备，0x14 系列）

| msgType | 效果 | values 参数序（回路=0 开头） |
|---|---|---|
| 0x14030000 | 流水 | 回路,模式0,颜色,速度(1-100),循环(0/1) |
| 0x14050000 | 跑马 | 回路,模式1,颜色,速度,方向(正向0/逆向1) |
| 0x14070000 | 呼吸 | 回路,模式2,颜色,速度 |
| 0x14090000 | 律动 | 回路,模式3,颜色,速度 |
| 0x140B0000 | 静态色温渐变 | 回路,模式4,起始色温,结束色温,方向 |
| 0x140D0000 | 动态色温渐变 | 回路,模式5,起始色温,结束色温,渐变时长(1-10) |
| 0x140F0000 | 静态颜色渐变 | 回路,模式6,颜色,方向 |

共享颜色枚举（CXCY 多选）：星云/梦幻/火烧云/加州阳光/晚霞/睡莲等。

### 6.4 局域网直控通道（重要架构发现）

`sendDeviceControl`（源码行 554920）在设备同网段时走 **UDP 直发**（`iotctrl.opple.com`/网关 IP，端口 65501，`OPIOTIPPort`），绕过云端——这是第一次抓包抓不到控制指令的原因。云端 `CallAction` 是远程/兜底通道，两者参数结构一致（LAN 控制 msgType/data 由 App 内部序列化，若需要本地毫秒级控制可后续逆向该 UDP 协议）。

### 6.5 房间批量控制

- `GET /api/Area/AdjustBright?gpNo=<房间>&bright=<1-255>`（实测 198）
- `GET /api/Area/AdjustCCT?gpNo=<房间>&temperature=<K>`（实测 8195、10894）
- 另有 `/api/Area/AdjustColor`、`AdjustByTemplate`、`/api/area/GroupControl`

**全部 552 个接口路径已导出**：`data/api_paths.txt`

## 7. 对适配器开发的意义

1. **不需要实现签名**：控制链路只需 Token + ProjectCode + 固定 headers。
2. **Token 生命周期**：CheckAndRefreshToken 定期刷新（App 启动时调用）；写适配器时同样在启动时刷新即可。
3. **设备模型已就绪**：`FindDeviceListByPage`（列表+状态）+ `FindActionAbilityByVDeviceId`（动作枚举）+ `CallAction`（执行）三件套，正好映射统一设备模型的"设备→属性/动作"。
4. **实时状态**：socket.io over WebSocket（EIO=3 协议，标准 socket.io 客户端库可直接用），按 ucloundid 订阅。
5. **下一步缺口**：
   - 用真机补抓一次 CallAction 的完整请求（手机断 Wi-Fi 用蜂窝网络操作开关灯），确认参数结构
   - 登录接口的请求体结构（验证码登录或一键登录）
   - socket.io 的事件名和消息格式

## 8. 文件清单

```
data/
├── opple_smarthome_5.8.0.apk   # 原始 APK (370MB)
├── extracted/assets/index.android.bundle  # Hermes 字节码
├── decompiled.js               # 反编译 JS (99MB)
└── api_paths.txt               # 全部 552 个 API 路径
```

## 9. 法律声明

本分析仅用于用户自有设备的互操作性开发（个人智能家居统一管理），遵循 REA 的合法使用条款（研究/教育/互操作/软件保存）。不得将逆向所得协议用于对外服务或攻击行为。
