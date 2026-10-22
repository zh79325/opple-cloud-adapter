---
kind: external_dependency
name: 欧享家（Opple INNO）智能家居云端服务
slug: opple-smarthome-cloud
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
    - framework_behavior
scope:
    - '**'
---


- 主 API 域名 `https://iot2.opple.com`：家庭/房间/设备树、CallAction 控制指令等；局域网直控走 `https://iotctrl.opple.com` 端口 65501 的 UDP 通道（同网段时绕过云端）。
- 鉴权：普通业务接口无签名，仅依赖全小写请求头 `token` + `projectcode` + `clientid` + `app-version` + `ostype` + `lang`；混用 PascalCase 会返回 12004/11009 错误。Token 由用户通过 CLI `opple token save` 保存，生命周期可调用 `/api/User/CheckAndRefreshToken` 刷新。
- 实时状态通过 `wss://iot2.opple.com/socket.io/?token=xxx&ucloundid=xxx`（socket.io EIO=3）推送。
- 本仓库未使用官方 SDK，所有协议细节来自 APK 反编译 + Reqable 抓包交叉验证，详见 docs/reverse-engineering-report.md。