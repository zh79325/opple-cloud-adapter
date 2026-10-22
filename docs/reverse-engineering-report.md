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
- 入参包含 VDeviceId/DeviceId + ActionId/参数，具体 action 枚举由 `FindActionAbility` 系列接口查询：
  - `/api/Device/FindActionAbilityByVDeviceId`（按设备查可用动作）
  - `/api/Device/FindActionAbility`、`FindActionAbilityWithStatus`
- 灯光控制相关辅助接口：`/api/Area/AdjustBright`、`AdjustCCT`、`AdjustColor`、`StepDimming`、`StepAdjustCCT`、`/api/area/GroupControl`

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
