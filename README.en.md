# opencode-zh-desktop

[![npm version](https://img.shields.io/npm/v/opencode-zh-desktop?color=green&label=npm)](https://www.npmjs.com/package/opencode-zh-desktop)
[![npm downloads](https://img.shields.io/npm/dt/opencode-zh-desktop?color=blue)](https://www.npmjs.com/package/opencode-zh-desktop)
[![GitHub stars](https://img.shields.io/github/stars/mike652638/opencode-zh-desktop?style=flat)](https://github.com/mike652638/opencode-zh-desktop/stargazers)
[![license](https://img.shields.io/npm/l/opencode-zh-desktop)](./LICENSE)
[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/mike652638/opencode-zh-desktop/ci.yml?branch=main)](https://github.com/mike652638/opencode-zh-desktop/actions)

CDP-based Chinese locale injection for [OpenCode Desktop](https://opencode.ai/download) — patches the Electron renderer at runtime via Chrome DevTools Protocol. Includes daemon mode with auto-restart, reconnect, and hot-reload.

Companion package to [opencode-zh-plugin](https://www.npmjs.com/package/opencode-zh-plugin) (server-side AI response localization).

[中文文档](https://github.com/mike652638/opencode-zh-desktop/blob/main/README.md)

## Screenshots

**Chinese menu bar**

![Chinese menu bar](https://raw.githubusercontent.com/mike652638/opencode-zh-desktop/main/assets/menu-zh.png)

**Chinese settings page**

![Chinese settings page](https://raw.githubusercontent.com/mike652638/opencode-zh-desktop/main/assets/settings-zh.png)

**Custom theme (background image + glass layer + atmosphere glow + grid texture)**

![Custom theme](https://raw.githubusercontent.com/mike652638/opencode-zh-desktop/main/assets/custom-theme.png)

## Architecture

```
opencode-zh-desktop
  │
  ├── 1. Find OpenCode.exe (Win/Mac/Linux)
  ├── 2. Kill existing instance (graceful WM_CLOSE)
  ├── 3. Re-launch with --remote-debugging-port=19222
  ├── 4. Connect via CDP WebSocket to Electron renderer
  ├── 5. Page.addScriptToEvaluateOnNewDocument (persistent injection)
  │     ├── setLocale() — storeSet("language", zh) via window.api
  │     ├── TRANSLATIONS — 950 English→Chinese mappings (auto-generated)
  │     ├── processTree() — TreeWalker scans all TEXT_NODEs + attributes
  │     ├── splitTextByShortcut() — handles "Ctrl+Shift+S" glued to text
  │     └── startObserver() — MutationObserver catches dynamic DOM changes
  └── 6. Daemon mode: auto-restart, exponential backoff reconnect, hot-reload
```

## Installation

```bash
npm install -g opencode-zh-desktop
# or
npx opencode-zh-desktop [options]
```

## Usage

### One-shot mode

Connects to an existing OpenCode Desktop instance and injects translations:

```bash
opencode-zh-desktop --no-relaunch
```

### Full mode (kill + restart + inject)

Finds and restarts OpenCode Desktop with CDP enabled:

```bash
opencode-zh-desktop
```

### Daemon mode (recommended)

Keeps injection alive across Desktop restarts:

```bash
opencode-zh-desktop --daemon
```

To launch Desktop without inheriting system proxy variables, use:

```bash
opencode-zh-desktop --daemon --no-proxy
```

### Options

| Flag | Description | Default |
|---|---|---|
| `--port <n>` | CDP debugging port | `19222` |
| `--exe <path>` | Path to OpenCode.exe | Auto-detected |
| `--no-relaunch` | Connect to running instance, don't restart | `false` |
| `--force-relaunch` | Force restart even when CDP is available | `false` |
| `--no-proxy` | Remove proxy environment variables when launching Desktop | `false` |
| `--daemon` | Keep alive, auto-restart Desktop | `false` |
| `--theme <file>` | Load and inject a custom theme JSON | — |
| `--version`, `-v` | Show version | — |

## Theme Management

The first phase provides pure theme management without modifying the OpenCode installation or requiring CDP:

```bash
opencode-zh-desktop theme list            # List built-in presets
opencode-zh-desktop theme detect           # Detect theme directories
opencode-zh-desktop theme export sea-breeze --out sea-breeze.json
opencode-zh-desktop theme import sea-breeze.json
opencode-zh-desktop theme set-color sea-breeze.json dark text-base '#d7e8f5'
opencode-zh-desktop theme contrast sea-breeze.json
opencode-zh-desktop theme assets sea-breeze.json
opencode-zh-desktop --daemon --theme sea-breeze.json
opencode-zh-desktop theme reset
```

### Visual Themes

Theme files can include `visuals` in `light`/`dark` variants, and per-page overrides via the top-level `pages` key:

```json
{
  "light": {
    "visuals": {
      "backgroundImage": "assets/home-light.jpg",
      "glassOpacity": 0.42,
      "glassBlur": 18,
      "atmosphere": true,
      "atmosphereOpacity": 0.65
    }
  },
  "pages": {
    "session": { "glassOpacity": 0.5 },
    "settings": { "atmosphere": false }
  }
}
```

Visual layers are independent DOM nodes with `pointer-events: none` and never replace native controls. Respects `prefers-reduced-transparency` and `forced-colors` for accessibility. `theme reset` cleans up all visual layers, glass, atmosphere, and CSS injections at runtime.

## Translation Coverage

| Layer | Coverage | Mechanism |
|---|---|---|
| Menu bar items | ~100% | DOM text node replacement |
| Submenu items | ~100% | DOM replacement |
| Settings labels | ~100% | DOM replacement |
| Dialog buttons | ~100% | DOM replacement |
| Tooltips / placeholders | ~95% | Attribute replacement |
| Electron native menus (Go / Window) | 0% | OS-rendered, outside DOM |
| System dialogs | 0% | Hardcoded in updater/cli (`#10840`) |

### Translation Data

The 950 translation pairs were automatically generated from OpenCode's official i18n files:

- `packages/app/src/i18n/en.ts` (965 keys)
- `packages/app/src/i18n/zh.ts` (980 keys)
- `packages/desktop/src/renderer/i18n/` (21 keys)

Run `npm run build-map` to regenerate from latest upstream translations.

## Combined Coverage (with opencode-zh-plugin)

| Surface | opencode-zh-plugin | opencode-zh-desktop |
|---|---|---|
| AI replies + reasoning | ✅ system.transform hook | — |
| TUI slots + slash commands | ✅ slot replacement + commands | — |
| Desktop menu bar | — | ✅ CDP DOM replacement |
| Desktop submenus | — | ✅ CDP DOM replacement |
| Desktop settings/dialogs | — | ✅ CDP DOM replacement |
| TUI/CLI hardcoded strings | ❌ needs upstream PR | ❌ not in scope |
| System dialogs | ❌ upstream #10840 | ❌ upstream #10840 |

## How It Works

### Technique

Uses **Chrome DevTools Protocol** to attach to OpenCode Desktop's Electron renderer process. The same technique used by CodexPlusPlus for OpenAI Codex Desktop.

1. `Page.addScriptToEvaluateOnNewDocument` injects a script that runs before any page JS
2. `Runtime.evaluate` executes `init()` on the already-loaded page
3. A `MutationObserver` catches DOM changes for dynamically-rendered components
4. Shadow DOM is recursively scanned for web component content
5. Three delayed rescans (500ms / 1500ms / 3000ms) catch lazy-loaded UI

### Limitations

- **Flicker**: English text may appear briefly before replacement (DOM-mutation timing)
- **One-shot**: Without `--daemon`, injections are lost on page reload
- **Electron menus**: The Go / Window menu is native OS rendering, not DOM
- **Version dependent**: Upstream UI changes may break text matching
- **Terminal safety**: An existing CDP instance is reused by default, avoiding Desktop restarts that can disturb an active TUI; use `--force-relaunch` only when explicitly needed
- **Proxy isolation**: `--no-proxy` only removes proxy variables from newly launched Desktop processes; it does not change the daemon or system environment

## Development

```bash
git clone https://github.com/mike652638/opencode-zh-desktop.git
cd opencode-zh-desktop
npm install
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm run start        # Run the CLI
```

## Related

- [opencode-zh-plugin](https://www.npmjs.com/package/opencode-zh-plugin) — Server-side plugin for AI response localization
- [OpenCode](https://github.com/anomalyco/opencode) — The AI coding CLI
- [OpenCode Desktop](https://opencode.ai/download) — Desktop app

## License

MIT © 2026 mike652638
