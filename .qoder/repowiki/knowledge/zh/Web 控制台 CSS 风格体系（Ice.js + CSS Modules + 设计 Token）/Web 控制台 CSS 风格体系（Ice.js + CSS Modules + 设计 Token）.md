---
kind: frontend_style
name: Web 控制台 CSS 风格体系（Ice.js + CSS Modules + 设计 Token）
category: frontend_style
scope:
    - '**'
source_files:
    - web/src/global.css
    - web/src/pages/index.module.css
    - web/.stylelintrc.cjs
    - web/package.json
---

## 1. 使用的系统与工具

- **框架**：基于 [Ice.js](https://ice.work/) (`@ice/app` v3.4、`@ice/runtime` v1.4) 的 React 18 Web 应用，位于 `web/` 子目录。
- **样式方案**：**CSS Modules**（文件以 `.module.css` 命名），由 Ice.js 默认支持；全局样式放在 `src/global.css`，由 Ice.js 自动注入。
- **样式检查**：通过 `stylelint` v15.2 执行，规则来自阿里内部规范 `@applint/spec` 的 `react` 预设（见 `.stylelintrc.cjs`）。
- **无第三方 UI 组件库**：依赖清单中只有 `react` / `react-dom`，所有按钮、卡片、面板等均由手写 CSS 实现。
- **无预处理器**：仓库未引入 Sass/Less/Tailwind，全部为原生 CSS。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `web/src/global.css` | 全局 CSS 变量（设计 Token）、深色主题、字体与背景 |
| `web/src/pages/index.module.css` | 页面级样式（顶栏、房间卡片、3D 场景、二维编辑器、设备面板等，约 1100 行） |
| `web/.stylelintrc.cjs` | 继承 `@applint/spec/react` 的 Stylelint 规则集 |
| `web/package.json` | 声明 `stylelint` 脚本 `stylelint "src/**/*.{css,scss,less}" --cache` |
| `web/ice.config.mts` | Ice.js 构建配置（样式打包由框架处理） |

## 3. 架构与设计约定

### 3.1 设计 Token（Design Tokens）
所有颜色、线条、文字色值集中在 `:root` 下，作为单一事实来源：

```css
:root {
  color-scheme: dark;
  --bg: #070b16;
  --line: rgba(148, 163, 184, 0.16);
  --text-1: #e7ecf6;
  --text-2: #aab3c8;
  --text-3: #6b7590;
  --accent: #818cf8;
}
```

- 语义化命名：`--text-1` / `--text-2` / `--text-3` 表示三级文字层级，`--line` 统一描边/分割线透明度，`--accent` 为主强调色。
- 全站使用 `color-scheme: dark` 强制深色模式。
- 组件内不出现硬编码颜色（除少量状态色如 `#34d399` 在线绿、`#fbbf24` 警告黄），均引用上述 token。

### 3.2 命名与组织
- 采用 **BEM 风格的扁平类名**（无前缀、无嵌套选择器），如 `.topbar`、`.roomCard`、`.panelGroup`、`.deviceItem`。
- 每个页面一个 `.module.css` 文件，类名在模块作用域内，避免冲突。
- 通过 CSS 注释分区块（`/* ========== 顶栏 ========== */`、`/* ========== 3D 场景 ========== */` 等）划分大段逻辑。

### 3.3 视觉风格
- **暗色玻璃态**：大量使用 `backdrop-filter: blur(...)`、半透明渐变背景 `linear-gradient(165deg, rgba(255,255,255,0.05), ...)` 与 `rgba(..., 0.xx)` 边框。
- **主色调**：靛紫到品红的渐变色系（`#6366f1 → #8b5cf6 → #a855f7`），用于品牌 Logo、主按钮、激活态 Pill。
- **3D 场景**：纯 CSS 3D transform（`transform-style: preserve-3d`、`rotateX/Y/Z`）渲染房间地板、墙面、灯具，配合径向光晕模拟发光效果。
- **微交互**：统一的 `transition: ... 0.18s ease` 缓动，hover 时提升亮度 `filter: brightness(1.12)` 或位移 `translateY(-4px)`。

### 3.4 响应式策略
- 未使用媒体查询。布局主要依赖 Flexbox 与 CSS Grid：
  - `.roomGrid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }`
  - `.statsRow { grid-template-columns: repeat(3, 1fr); }`
  - `.roomLayout { grid-template-columns: minmax(0, 1fr) 320px; }`
- 通过 `minmax()` 和 `auto-fill` 实现自适应网格，侧边栏固定 300–320px。

## 4. 约定与约束

- **样式必须写为 CSS Modules**：文件名遵循 `*.module.css`，由 Ice.js 编译后生成唯一类名。
- **禁止直接 import 普通 CSS 文件**：全局样式仅通过 `global.css` 暴露，组件内不得再引入其他 `.css`。
- **颜色与间距应复用 `:root` 中的 CSS 变量**，避免在组件样式中散落硬编码色值。
- **Stylelint 强制执行**：`.stylelintrc.cjs` 通过 `getStylelintConfig('react')` 启用阿里内部规范，CI 可通过 `npm run stylelint` 校验。
- **无 Tailwind / Sass / Less**：项目未安装任何 CSS 预处理器或原子化框架，新增样式需遵循现有手写 CSS Modules 范式。
- **字体栈**：`-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', 'Microsoft YaHei', sans-serif`，优先系统字体并回退到苹方/微软雅黑。
- **数字排版**：数值型文本统一使用 `font-variant-numeric: tabular-nums`，保证等宽对齐（统计数字、时间戳等）。