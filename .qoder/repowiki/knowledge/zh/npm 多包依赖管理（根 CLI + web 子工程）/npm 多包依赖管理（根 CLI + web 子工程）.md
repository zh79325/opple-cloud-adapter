---
kind: dependency_management
name: npm 多包依赖管理（根 CLI + web 子工程）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - web/package.json
    - web/package-lock.json
    - .gitignore
---

## 1. 使用的系统/方式

仓库采用 **npm** 作为唯一的包管理器，使用两个独立的 `package.json` 分别声明依赖：
- 根目录 `package.json`：CLI 与 Node 服务端（`opple-cli`），无运行时依赖，仅通过 `bin` 字段暴露 `opple` 命令。
- `web/package.json`：基于 Ice.js + React 的前端控制台（`opple-web`），声明了运行时与开发依赖。

未使用 yarn、pnpm、Go modules、Cargo、pip 等其它语言生态的依赖管理工具；也未见 vendoring 目录或私有 registry 配置。