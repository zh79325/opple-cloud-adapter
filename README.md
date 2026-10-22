# opple-cloud-adapter — 欧享家（欧普 INNO 生态）本地控制

通过逆向欧享家云端 API，实现欧普 INNO 设备的本地统一控制：CLI + Web 控制台（含 Three.js WebGL 3D 空间建模与真实光照渲染）。
协议逆向全记录见 `docs/reverse-engineering-report.md`。

## 组成

| 模块 | 位置 | 说明 |
|---|---|---|
| CLI | `bin/opple.js` + `src/cli.js` | 零依赖（Node 22+）命令行控制 |
| API 客户端 | `src/opple/client.js` | OppleClient（请求头/鉴权/接口封装） |
| Web 后端 | `src/opple/server.js` | 零依赖 Node http 服务（端口 5170） |
| Web 前端 | `web/`（ice.js v3 + Three.js） | 家庭/房间/设备 + 位置编辑 + WebGL 3D 光照预览 |
| 逆向产物 | `data/` | APK、反编译 JS、552 个接口清单、抓包样本 |
| 空间数据 | `data/device-positions.json` | 房间尺寸 + 设备 3D 几何位置 |
| 数据快照 | `data/local-tree.json` | 家庭/房间/设备本地快照（"同步数据"写入） |

## 快速开始

```bash
# CLI（可选全局安装）
npm link
opple token save <32位token> <projectCode>   # 凭据来自抓包（见下）
opple tree                                    # 家庭→房间→设备 三层结构
opple devices 客厅                            # 按房间过滤设备
opple actions 2122050                         # 查设备全部动作+参数范围
opple light 2122050 cct 4000                  # 色温 4000K
opple light 2122050 color "#FF8000"           # RGB 自动转 CXCY
opple scene 2122018 跑马 speed=70 direction=reverse  # 灯效
opple raw GET /api/Project/GetHomeList        # 调试任意接口

# Web 控制台
node src/opple/server.js                       # 或 npm run web
# 打开 http://localhost:5170
# ⛅ 同步数据：一键拉取欧享家云端最新家庭/房间/设备到本地快照（data/local-tree.json）
#      之后页面数据全部读本地快照，不再每次请求云端；位置编辑仍实时保存
# ➜ 家庭页：房间卡片列表，点击进入房间 WebGL 3D 预览
#      Three.js 真实光照：吸顶灯=暖色点光源、灯带=紫色点光源，实时照亮墙面/地面并投影
#      自由视角：左键旋转 / 右键平移 / 滚轮缩放 / 双击或「复位视角」按钮还原
# ✎ 编辑布局：二维平面拖拽设备（灯=圆盘可调大小、灯带=折线路径可弯折）+ 尺寸/高度滑杆与数字输入
```

## Token 获取

Reqable 抓包（手机连电脑代理 + 信任证书），从任意 `iot2.opple.com` 请求的 `token` 头取 32 位 hex，`projectcode` 同理（如 356748）。

⚠️ **请求头必须全小写**（token/projectcode/clientid…），混用大小写会收到 12004/11009 错误——详见逆向报告第 3 节。

## CLI 命令

| 命令 | 说明 |
|---|---|
| `token save/check` | 保存/校验凭据 |
| `tree` | 家庭→房间→设备 三层树 |
| `devices [房间]` | 设备列表（可按房间名/Gpno 过滤） |
| `actions <id>` | 全部可调用动作（msgType/参数范围/枚举） |
| `light <id> <op> <值>` | on/off/bright(1-255或%)/cct(1800-12000K)/duv(-8~8)/color(预设或#RGB)/daylight |
| `scene <id> <效果> [k=v]` | 流水/跑马/呼吸/律动/三种渐变，含速度/方向/渐变时长 |
| `call <id> <msgType> <v1,v2…>` | 底层命令调用 |
| `raw <METHOD> <path> [json]` | 任意接口调试 |

## Web API

| 接口 | 说明 |
|---|---|
| `GET /api/tree` | 三层结构 + 房间 shape + 设备 position；本地快照优先（`source: local`），无快照时回源云端并落盘 |
| `POST /api/sync` | 一键同步：拉取欧享家云端最新结构写入本地快照，返回最新树 |
| `POST /api/positions` | 保存房间布局：`shape`/`positions`/`excluded` 均可选，只传哪个更新哪个（实时写盘，不经快照） |
| `GET /api/positions?projectCode=` | 导出空间数据（供 AI 空间推理） |
| `GET /api/actions?vDeviceId=` | 设备动作能力 |
| `GET /api/summary` `/api/homes` `/api/devices` | 设备摘要/家庭/设备列表（实时请求云端） |

## 空间模型（供 AI 组合控制）

```js
房间:  { w: 100, h: 45, depth: 100 }                // 宽/高/深（5m×2.3m×5m）
吸顶灯: { kind: 'circle', x, y, r, elev }            // 圆心+半径+离地高度百分比
灯带:  { kind: 'segment', points: [{x,y},...], elev } // 平面路径折线（≥2 顶点，可弯折软带）+ 安装高度百分比
网关:  { kind: 'point', x, y, elev }
```

- `elev` 存储为**离地百分比**（0=地面，100=天花）；控制台 UI 统一以「距顶」米数呈现（距顶 = (100-elev)×0.05m），符合吸顶灯贴顶的直觉。
- 灯带是**可弯折软带**：路径为折线 `points`（相邻顶点连直线段），编辑器支持拖顶点变形、拖段间手柄加顶点、双击顶点删除；旧格式（x1,y1,x2,y2 两点直线）读入时自动归一化，保存后升级为新格式。
- 网关等点位设备与**手动排除**的设备（控制台设备清单中眼睛图标切换，存入房间的 `excluded` 列表）不参与位置编辑、3D 渲染与 `/api/positions` 导出。

`GET /api/positions` 输出的几何带形态语义：AI 可据此推理"电视墙氛围光 = 右墙 segment 灯带低亮度暖色 + 关闭中央 circle 主灯"这类组合控制。

## 已验证（实测）

- ✅ 请求头/鉴权/接口结构（CLI + Web 全链路，15 台设备真实数据）
- ✅ 三层模型（GetHomeList → FindUserRoomList → FindDeviceAndGroupListV2）
- ✅ 调光/调色温/调颜色 CallAction（4 条抓包样本 + CXCY 编码与官方枚举比对吻合）
- ✅ 位置编辑/WebGL 3D 光照渲染端到端（Three.js 点光源/自发光/阴影，拖拽→保存→刷新还原）
- ✅ 排除/恢复端到端（清单切换→3D/编辑器/导出同步生效，位置数据保留）
- ✅ 灯带路径编辑（拖顶点弯折/段间加顶点/双击删除 → 3D 多段折线渲染，存储升级为 points）
- ✅ 本地快照同步（POST /api/sync 落盘 → GET /api/tree 本地毫秒级响应，位置数据实时合并）
- ⏳ 灯效（0x14 系列）组包顺序：能力表推断，待真机下发验证
- ⏳ 登录接口请求体（验证码/一键登录）

## 逆向方法摘要

APK（官网渠道 MD5 校验）→ REA/apktool 解 manifest → 定位 React Native Hermes bundle（`index.android.bundle` v96）→ hbc-decompiler 反编译出 99MB 可读 JS → 搜索域名/命令字/签名关键词定位网络层 → 与 Reqable 抓包互相印证。详见 `docs/reverse-engineering-report.md`。

## 法律声明

仅用于自有设备的互操作性开发（个人智能家居统一管理）。不得将逆向协议用于对外服务。
