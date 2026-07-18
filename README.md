# opencode-zh-desktop

[![npm version](https://img.shields.io/npm/v/opencode-zh-desktop?color=green&label=npm)](https://www.npmjs.com/package/opencode-zh-desktop)
[![npm downloads](https://img.shields.io/npm/dt/opencode-zh-desktop?color=blue)](https://www.npmjs.com/package/opencode-zh-desktop)
[![GitHub stars](https://img.shields.io/github/stars/mike652638/opencode-zh-desktop?style=flat)](https://github.com/mike652638/opencode-zh-desktop/stargazers)
[![license](https://img.shields.io/npm/l/opencode-zh-desktop)](./LICENSE)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/mike652638/opencode-zh-desktop/ci.yml?branch=main)](https://github.com/mike652638/opencode-zh-desktop/actions)

基于 CDP（Chrome DevTools Protocol）的 [OpenCode Desktop](https://opencode.ai/download) 中文注入工具 — 在运行时通过 Electron 的调试协议向渲染进程注入翻译脚本。支持守护进程模式，含自动重启、断线重连和热重载。

[opencode-zh-plugin](https://www.npmjs.com/package/opencode-zh-plugin) 的配套包（负责 AI 回复语言中文化）。

[English](https://github.com/mike652638/opencode-zh-desktop/blob/main/README.en.md)

## 效果预览

**菜单栏中文化**

![菜单栏翻译](https://raw.githubusercontent.com/mike652638/opencode-zh-desktop/main/assets/menu-zh.png)

**设置页中文化**

![设置页翻译](https://raw.githubusercontent.com/mike652638/opencode-zh-desktop/main/assets/settings-zh.png)

## 架构

```
opencode-zh-desktop
  │
  ├── 1. 查找 OpenCode.exe（Win/Mac/Linux 自动探测）
  ├── 2. 终止现有实例（WM_CLOSE 优雅关闭）
  ├── 3. 以 --remote-debugging-port=19222 重新启动
  ├── 4. 通过 CDP WebSocket 连接 Electron 渲染进程
  ├── 5. Page.addScriptToEvaluateOnNewDocument（持久注入）
  │     ├── setLocale() — 通过 window.api 调用 storeSet("language", zh)
  │     ├── TRANSLATIONS — 950 条英→中映射（自动生成）
  │     ├── processTree() — TreeWalker 扫描全树 TEXT_NODE + 属性
  │     ├── splitTextByShortcut() — 处理粘连快捷键文本
  │     └── startObserver() — MutationObserver 捕获动态 DOM 变化
  └── 6. 守护进程模式：自动重启、指数退避重连、脚本热重载
```

## 安装

```bash
npm install -g opencode-zh-desktop
# 或者
npx opencode-zh-desktop [选项]
```

## 使用

### 单次注入

连接到已运行的 OpenCode Desktop 实例并注入翻译：

```bash
opencode-zh-desktop --no-relaunch
```

### 完整模式（终止 + 重启 + 注入）

自动查找并重启 OpenCode Desktop，启用 CDP 调试端口：

```bash
opencode-zh-desktop
```

### 守护进程模式（推荐）

Desktop 退出后自动重启并重新注入：

```bash
opencode-zh-desktop --daemon
```

### 命令行选项

| 选项 | 说明 | 默认值 |
|---|---|---|
| `--port <n>` | CDP 调试端口 | `19222` |
| `--exe <path>` | OpenCode.exe 路径 | 自动探测 |
| `--no-relaunch` | 连接已运行实例，不重启 | `false` |
| `--daemon` | 守护进程，自动重启 Desktop | `false` |
| `--version`, `-v` | 显示版本号 | — |

## 翻译覆盖

| 层级 | 覆盖率 | 机制 |
|---|---|---|
| 菜单栏 | ~100% | DOM 文本节点替换 |
| 子菜单项 | ~100% | DOM 替换 |
| 设置标签 | ~100% | DOM 替换 |
| 对话框按钮 | ~100% | DOM 替换 |
| 工具提示 / 占位符 | ~95% | 属性替换 |
| Electron 原生菜单（Go / Window） | 0% | OS 级渲染，不在 DOM 中 |
| 系统对话框 | 0% | updater/cli 硬编码（上游 #10840） |

### 翻译数据

950 条翻译对应关系自动从 OpenCode 官方 i18n 文件生成：

- `packages/app/src/i18n/en.ts`（965 个 key）
- `packages/app/src/i18n/zh.ts`（980 个 key）
- `packages/desktop/src/renderer/i18n/`（21 个 key）

运行 `npm run build-map` 从上游最新翻译重新生成。

## 组合覆盖（配合 opencode-zh-plugin）

| 表面 | opencode-zh-plugin | opencode-zh-desktop |
|---|---|---|
| AI 回复 + 推理过程 | ✅ system.transform hook | — |
| TUI 插槽 + 斜杠命令 | ✅ slot 替换 + commands | — |
| Desktop 菜单栏 | — | ✅ CDP DOM 替换 |
| Desktop 子菜单 | — | ✅ CDP DOM 替换 |
| Desktop 设置/对话框 | — | ✅ CDP DOM 替换 |
| TUI/CLI 硬编码字符串 | ❌ 需上游 PR | ❌ 不在此范围 |
| 系统对话框 | ❌ 上游 #10840 | ❌ 上游 #10840 |

## 技术原理

### 实现方式

使用 **Chrome DevTools Protocol** 连接到 OpenCode Desktop 的 Electron 渲染进程。与 CodexPlusPlus 为 OpenAI Codex Desktop 使用的技术相同。

1. `Page.addScriptToEvaluateOnNewDocument` 在页面 JS 执行前注入脚本
2. `Runtime.evaluate` 在已加载的页面上执行 `init()`
3. `MutationObserver` 捕获动态渲染组件的 DOM 变化
4. 递归扫描 Shadow DOM 以覆盖 web component 内容
5. 三次延迟重扫描（500ms / 1500ms / 3000ms）捕获延迟加载的 UI

### 局限性

- **闪烁**：英文文本可能在替换前短暂闪现（DOM 变更时序问题）
- **一次性**：不加 `--daemon` 时，页面重载后注入丢失
- **Electron 菜单**：Go / Window 菜单为本地 OS 渲染，不在 DOM 中
- **版本依赖**：上游 UI 变更可能破坏文本匹配

## 开发

```bash
git clone https://github.com/mike652638/opencode-zh-desktop.git
cd opencode-zh-desktop
npm install
npm run typecheck    # 仅类型检查
npm run build        # 编译到 dist/
npm run start        # 运行 CLI
```

## 相关链接

- [opencode-zh-plugin](https://www.npmjs.com/package/opencode-zh-plugin) — 服务端插件，负责 AI 回复中文化
- [OpenCode](https://github.com/anomalyco/opencode) — AI 编程 CLI
- [OpenCode Desktop](https://opencode.ai/download) — 桌面应用

## 许可证

MIT © 2026 mike652638
