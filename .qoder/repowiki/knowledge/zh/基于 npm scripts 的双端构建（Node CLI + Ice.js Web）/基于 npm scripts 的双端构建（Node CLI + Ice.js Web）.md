---
kind: build_system
name: 基于 npm scripts 的双端构建（Node CLI + Ice.js Web）
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - bin/opple.js
    - src/cli.js
    - src/opple/client.js
    - src/opple/server.js
    - web/package.json
    - web/ice.config.mts
    - web/tsconfig.json
    - web/.eslintrc.cjs
    - web/.stylelintrc.cjs
    - web/.browserslistrc
---

## 1. 使用的系统/方法

仓库采用纯 npm 脚本驱动，没有 Makefile、Dockerfile、CI 流水线或自定义构建脚本。根项目与 `web/` 子目录各自维护独立的 `package.json`，分别负责 Node CLI 和 Web 前端的依赖管理与构建。

- 根项目 (`opple-cli`)：Node.js ESM 模块，通过 `bin.opple` 暴露命令行入口 `bin/opple.js`。
- Web 前端 (`opple-web`)：基于 Ice.js (`@ice/app`) + React 18 的 SPA，使用 TypeScript 与 CSS Modules。

## 2. 关键文件

- `package.json`（根）：定义 CLI 包名、`bin` 映射、`scripts.opple` / `scripts.web`、`engines.node >= 22`。
- `bin/opple.js`：CLI 可执行入口。
- `src/cli.js`、`src/opple/client.js`、`src/opple/server.js`：CLI 与轻量 Node 后端共享的 OppleClient 鉴权与设备树逻辑。
- `web/package.json`：Ice.js 构建脚本（`start` / `build`）、ESLint / Stylelint 脚本。
- `web/ice.config.mts`：Ice.js 构建配置。
- `web/tsconfig.json`、`web/.eslintrc.cjs`、`web/.stylelintrc.cjs`：Web 端类型与代码风格配置。
- `web/.browserslistrc`：浏览器兼容目标。

## 3. 架构与约定

- **双包结构**：根 `package.json` 仅管理 Node 侧运行时依赖；`web/package.json` 独立管理前端依赖，二者互不干扰。
- **CLI 发布方式**：通过 npm `bin` 字段将 `bin/opple.js` 注册为全局命令 `opple`，安装后即可在终端调用。
- **Web 构建流程**：开发用 `npm start`（即 `ice start --speedup`），生产构建用 `npm run build`（即 `ice build`），产物输出到 `web/build/`。
- **Node 版本约束**：根 `package.json` 声明 `engines.node >= 22`，强制运行环境。
- **模块格式**：根项目以 ESM 模式运行（`"type": "module"`），CLI 与 server 均使用 ES Module import/export。

## 4. 约定与约束

- **无 CI/CD 配置**：仓库根目录不存在 `.github/`、`.circleci/`、`.gitlab-ci.yml`、`Makefile`、`Dockerfile`、`*.sh` 等任何自动化构建或部署脚本，也未发现 release 相关工具（如 semantic-release、standard-version）。
- **无跨平台编译**：项目为纯 JavaScript/TypeScript，不涉及 C/C++ 扩展或原生模块，无需 cross-compile。
- **依赖锁定**：根目录未提供 `package-lock.json`（可能由 monorepo 工具或外部流程生成），但 `web/package-lock.json` 存在，用于固定前端依赖版本。
- **代码质量**：Web 端通过 ESLint (`eslint ./src --cache --ext .js,.jsx,.ts,.tsx`) 与 Stylelint (`stylelint "src/**/*.{css,scss,less}" --cache`) 进行静态检查，并提供 `:fix` 变体脚本。
- **版本策略**：根项目版本为 `0.1.0`，Web 端版本为 `1.3.0`，两者独立递增，未见统一的版本号同步机制。
- **发布配置**：`web/package.json` 中 `publishConfig.access = "public"`，表明 Web 包可发布至公共 npm registry；根 CLI 包未显式设置 publishConfig，沿用默认行为。