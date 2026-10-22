---
kind: logging_system
name: 基于 console 的轻量日志输出（无结构化日志框架）
category: logging_system
scope:
    - '**'
source_files:
    - bin/opple.js
    - src/cli.js
    - src/opple/server.js
---

## 1. 使用的系统/方案

仓库未引入任何第三方日志框架（如 winston、pino、log4js、signale、chalk 等），也未定义 `log/` 或 `logging/` 目录。所有日志输出均直接使用 Node.js 内置的 `console.log` / `console.error`，属于最轻量的“控制台直写”模式。

- CLI 入口 `bin/opple.js`：仅用 `console.error(err?.message ?? err)` 打印异常后 `process.exit(1)`。
- Web 后端 `src/opple/server.js`：启动时通过两条 `console.log` 输出监听端口与前端构建状态。
- CLI 命令逻辑 `src/cli.js`：大量使用 `console.log` 输出表格、设备树、操作结果、帮助信息等用户可见文本；错误路径统一通过 `throw new Error(...)` 由顶层捕获后走 `console.error`。

## 2. 关键文件

- `bin/opple.js` — CLI 进程入口，唯一集中处理未捕获异常的 `console.error` 位置。
- `src/cli.js` — 命令分发器，承载全部面向用户的 stdout 输出（help、table、tree、device list、action 下发确认等）。
- `src/opple/server.js` — 零依赖 HTTP 服务，仅两处 `console.log` 用于服务启动提示。

## 3. 架构与约定

- **无日志级别**：没有 info/warn/error/debug 分级，也没有环境变量控制输出开关。所有 `console.log` 既是业务输出也是“日志”。
- **无结构化字段**：输出为人类可读的字符串拼接（含 emoji 🏠🛏✅ 等装饰字符），不是 JSON 或带固定字段的记录对象。
- **无 sink/transport**：不写入文件、不发送到远端、不做异步缓冲，直接同步输出到 stderr/stdout。
- **错误处理约定**：CLI 侧的错误一律以抛出 `Error` 的方式上抛，由 `bin/opple.js` 统一 catch 并 `console.error` + 非零退出码；Web API 侧则在 try/catch 中返回 `{ error: e.message }` 给客户端，不在服务端额外打日志。
- **输出语义区分**：`console.log` 用于成功/查询结果/帮助信息；`console.error` 仅用于异常堆栈或失败提示。

## 4. 约定与约束

- **观察到的约定（descriptive）**：
  - 面向终端用户的输出集中在 `src/cli.js`，采用 `printTable` 辅助函数对齐列宽，并以 emoji 作为视觉标记（家庭、房间、在线/离线状态）。
  - 服务器启动提示位于 `src/opple/server.js` 末尾的 `createServer(...).listen` 回调内，包含端口号和前端构建就绪判断。
  - 所有 CLI 命令在参数校验失败时 `throw new Error('用法: ...')`，而非直接 `console.error`，保证错误出口单一。
  - Web API 的错误响应统一为 `{ error: message }` 结构体，HTTP 状态码根据场景取 400/500/502/404。

- **可验证的规则（enforced by code）**：
  - 项目未安装任何日志类 npm 包（仓库根及 `web/` 子项目的 `package.json` 中无相关依赖）。
  - 全仓 grep 仅匹配到 3 处 `console.*` 调用，且全部位于上述三个文件中，未发现其他模块存在日志输出。
  - 不存在任何日志配置文件、环境变量开关或日志等级常量。