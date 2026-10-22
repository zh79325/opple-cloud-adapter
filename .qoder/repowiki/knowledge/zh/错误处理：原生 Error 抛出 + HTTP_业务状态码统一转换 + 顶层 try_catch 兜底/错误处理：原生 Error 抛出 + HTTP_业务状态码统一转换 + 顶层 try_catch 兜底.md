---
kind: error_handling
name: 错误处理：原生 Error 抛出 + HTTP/业务状态码统一转换 + 顶层 try/catch 兜底
category: error_handling
scope:
    - '**'
source_files:
    - src/opple/client.js
    - src/opple/server.js
    - src/cli.js
---

## 1. 使用的系统/方式

仓库未引入任何第三方错误库，全部使用 JavaScript 原生 `Error`。错误传播通过 `throw new Error(...)` 向调用方冒泡，由上层（CLI 或 Web server）捕获并决定呈现形式。

## 2. 关键文件

- `src/opple/client.js` — 云端 API 客户端，集中定义 HTTP 与业务层错误语义
- `src/opple/server.js` — Node HTTP 服务，集中 catch 所有路由异常并返回 JSON
- `src/cli.js` — CLI 命令分发，直接 throw 给 Node 进程（无显式 try/catch）

## 3. 架构与约定

### 3.1 客户端层（OppleClient.request）

request() 是唯一的网络入口，统一把三类失败转为 Error：

- HTTP 非 200：throw new Error(`HTTP ${res.status} ${method} ${path}`)
- 响应体非 JSON：throw new Error(`响应非 JSON: ...`)
- 业务 StatusCode !== 0：throw new Error(`[${scNum}] ${json.Message ?? '未知错误'} (${path})`

注释明确说明“统一错误处理：StatusCode !== 0 视为失败（注意部分接口返回字符串 '0'）”，因此对 sc 做了 typeof sc === 'string' ? Number(sc) : sc 的兼容处理。

### 3.2 容错策略：.catch(() => [])

在 tree() 方法中，房间列表和设备列表请求被包裹为 .catch(() => [])，即单个房间拉取失败不影响其他房间。这是一种尽力而下的降级策略，而非向上抛出。

### 3.3 Web 服务端层（server.js）

- 每个 /api/* 路由分支内用 try { ... } catch (e) { return json(res, 502, { error: e.message }); } 包裹，将底层抛出的 Error 统一序列化为 { error: message } 并以 502 返回。
- 配置加载失败单独 catch：try { client = OppleClient.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }，返回 500 以区分配置缺失和下游异常。
- 参数校验失败走同步分支返回 400，例如 vDeviceId required、projectCode, gpno required。
- 未匹配的路径返回 404 { error: 'not found' }。
- 静态文件读取异常未被显式捕获，会沿 createServer 回调冒泡到 Node 默认 unhandled rejection handler。

### 3.4 CLI 层（cli.js）

CLI 没有全局 try/catch，所有参数校验、颜色解析、命令字校验等直接 throw new Error(...)，由 Node 运行时打印堆栈后退出。这符合 CLI 工具快速失败的常见模式。

### 3.5 本地 I/O 容错

loadTreeCache()、loadPositions() 等函数对 JSON.parse(readFileSync(...)) 使用 try/catch 并返回空对象/null，使缓存不存在或损坏被视为无缓存，而非启动失败。

## 4. 约定与约束

- 错误类型：全仓使用原生 Error，未定义自定义错误类或错误码枚举。
- HTTP 错误：由 OppleClient.request 统一把非 200 状态码包装为 Error，调用方无需判断 res.ok。
- 业务错误：云端响应的 StatusCode 字段统一检查，非 0 时抛出包含 [code] Message (path) 的错误；字符串 '0' 会被数值化兼容。
- Web 错误响应格式：所有 JSON 错误统一为 { error: string }，由 json() 辅助函数设置 Content-Type: application/json; charset=utf-8。
- 错误状态码约定：配置缺失 -> 500；路由内未捕获异常 -> 502；参数校验失败 -> 400；路径不存在 -> 404。
- 局部容错：tree() 中对房间/设备请求使用 .catch(() => []) 实现单房间失败不阻断整体树构建。
- CLI 无兜底：CLI 命令分支不捕获异常，依赖 Node 默认行为输出堆栈。
- 未覆盖点：静态文件读取、readBody 解析失败（已吞掉返回 {}）、checkToken 内部未做 res.ok 检查——这些属于当前实现中的遗漏，但仓库中没有统一的错误中间件来强制约束它们。