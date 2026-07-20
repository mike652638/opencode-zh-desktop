#!/usr/bin/env node
/**
 * opencode-zh-desktop: CDP-based Chinese locale injection for OpenCode Desktop.
 *
 * Usage:
 *   node bin/opencode-zh-desktop.js [options]
 *
 * Options:
 *   --port <number>     CDP port (default: 19222)
 *   --exe <path>        Path to OpenCode Desktop executable
 *   --no-relaunch       Don't kill/relaunch, connect to existing instance
 *   --force-relaunch    Force-kill and relaunch even when CDP is available
 *   --no-proxy          Remove proxy environment variables when launching Desktop
 *   --help, -h          Show help
 */

import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { launchDesktop, findDesktopExe } from "../dist/launcher.js"
import { findRendererTarget, connectCDP, injectPersistentScript, evaluateScript, enableDomains, setupConsoleCapture } from "../dist/connector.js"
import { buildInjectionScript } from "../dist/inject.js"
import { startDaemon } from "../dist/daemon.js"
import { checkContrast, createThemeJson, detectThemeDirectories, getPresetThemes, loadTheme, restoreDefaultTheme, saveTheme, updateThemeColor } from "../dist/theme-manager.js"
import { buildThemeCleanupScript, buildThemeScriptFromFile, buildThemeInjectionScript } from "../dist/theme-injector.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"))

async function main() {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  if (opts.help) {
    printHelp()
    process.exit(0)
  }

  if (opts.version) {
    console.log("opencode-zh-desktop v" + pkg.version)
    process.exit(0)
  }

  if (opts.theme) {
    await handleThemeCommand(opts.themeArgs)
    return
  }

  if (opts.daemon) {
    await startDaemon({ port: opts.port, exePath: opts.exe, noProxy: opts.noProxy, themePath: opts.themePath })
    return
  }

  console.log("opencode-zh-desktop — CDP Chinese locale injection for OpenCode Desktop\n")

  let port = opts.port

  if (!opts.noRelaunch) {
    console.log("Step 1: Launching OpenCode Desktop with CDP...")
    const result = await launchDesktop({ port, exePath: opts.exe, forceRelaunch: opts.forceRelaunch, noProxy: opts.noProxy })
    port = result.port
    if (result.reused) console.log("  Reused existing Desktop instance")
    else console.log("  PID:", result.pid)
    console.log("  Port:", port)
    if (result.exePath) console.log("  Exe:", result.exePath)
  } else {
    console.log("Step 1: Connecting to existing instance on port", port)
  }

  console.log("\nStep 2: Finding renderer target...")
  const target = await findRendererTarget(port, 30000)
  console.log("  Target:", target.title || "(untitled)")
  console.log("  URL:", target.url)

  console.log("\nStep 3: Connecting via WebSocket...")
  const session = await connectCDP(target)
  console.log("  Connected")

  console.log("\nStep 4: Enabling CDP domains and console capture...")
  await enableDomains(session)
  setupConsoleCapture(session)
  console.log("  Page + Runtime enabled")

  console.log("\nStep 5: Building and injecting translation script...")
  const script = buildInjectionScript()
  console.log("  Script length:", script.length)
  const idx = script.indexOf("__TRANSLATIONS__")
  console.log("  __TRANSLATIONS__ at index:", idx)
  if (idx >= 0) console.log("  Context:", JSON.stringify(script.substring(Math.max(0, idx - 40), idx + 50)))
  console.log("  Has 'Suggested' key:", script.includes('"Suggested"'))
  const identifier = await injectPersistentScript(session, script)
  console.log("  Script injected (id:", identifier + ")")

  console.log("\nStep 6: Running injection on current page...")
  await evaluateScript(session, script)
  console.log("  Done")

  // Step 7: Theme injection (optional)
  if (opts.themePath) {
    console.log("\nStep 7: Injecting theme CSS overrides...")
    try {
      const themeScript = buildThemeScriptFromFile(opts.themePath)
      console.log("  Theme script length:", themeScript.length)
      const themeId = await injectPersistentScript(session, themeScript)
      console.log("  Theme script injected (id:", themeId + ")")
      await evaluateScript(session, themeScript)
      console.log("  Theme applied")
    } catch (err) {
      console.error("  Theme injection failed:", err.message)
    }
  }

  console.log("\n=== opencode-zh-desktop is active ===")
  console.log("The Electron renderer is now being patched with Chinese translations.")
  console.log("This script will keep running. Press Ctrl+C to disconnect.")

  process.on("SIGINT", () => {
    console.log("\nDisconnecting...")
    session.close()
    process.exit(0)
  })

  setInterval(() => {}, 1000000)
}

function parseArgs(args) {
  const opts = { port: 19222, exe: undefined, noRelaunch: false, forceRelaunch: false, noProxy: false, help: false, daemon: false, version: false, theme: false, themeArgs: [], themePath: undefined }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "theme") {
      opts.theme = true
      opts.themeArgs = args.slice(i + 1)
      break
    }
    switch (args[i]) {
      case "--port":
        opts.port = parseInt(args[++i], 10)
        break
      case "--exe":
        opts.exe = args[++i]
        break
      case "--theme":
        opts.themePath = args[++i]
        break
      case "--no-relaunch":
        opts.noRelaunch = true
        break
      case "--force-relaunch":
        opts.forceRelaunch = true
        break
      case "--no-proxy":
        opts.noProxy = true
        break
      case "--daemon":
        opts.daemon = true
        break
      case "--version":
      case "-v":
        opts.version = true
        break
      case "--help":
      case "-h":
        opts.help = true
        break
    }
  }
  return opts
}

function printHelp() {
  console.log(`
opencode-zh-desktop — CDP Chinese locale injection for OpenCode Desktop

Usage:
  node bin/opencode-zh-desktop.js [options]

Options:
  --port <number>     CDP port (default: 19222)
  --exe <path>        Path to OpenCode Desktop executable
  --theme <file>      Path to a DesktopTheme JSON file to inject as CSS overrides
  --no-relaunch       Connect to existing instance instead of relaunching
  --force-relaunch    Force-kill and relaunch even when CDP is available
  --no-proxy          Remove proxy environment variables when launching Desktop
  --daemon            Run in daemon mode (auto-restart, hot-reload, reconnect)
  theme ...           Manage Desktop themes (list, detect, import, export, apply, contrast, reset)
  --version, -v       Show version
  --help, -h          Show this help

Description:
  Launches OpenCode Desktop with Chrome DevTools Protocol enabled,
  then injects a script that:
  1. Sets the locale to Chinese (zh)
  2. Replaces remaining English text in the DOM with Chinese translations

  With --theme <file>, also injects CSS variable overrides from the
  specified DesktopTheme JSON file. The theme is applied on every
  navigation and watches for light/dark mode changes automatically.

  With --daemon, runs as a long-lived process that:
  - Auto-restarts Desktop if it crashes
  - Reconnects with exponential backoff on disconnect
  - Hot-reloads the injection script on file changes
  - Hot-reloads the theme file when --theme is specified
`)
}

async function handleThemeCommand(args) {
  const [command, ...rest] = args
  if (!command || command === "help") {
    console.log(`
Theme commands:
  theme list                          List preset themes
  theme detect                        Detect theme directories
  theme create <id> <name>            Create a new theme
  theme set-color <file> <mode> <token> <color>  Edit a color token
  theme import <file>                 Import a theme file
  theme export <preset-id>            Export a preset theme
  theme contrast <file>               Check WCAG contrast ratios
  theme apply <file>                  Apply theme via CDP (one-shot)
  theme preview <file>                Preview generated CSS variables
  theme assets <file>                 Check referenced background assets
  theme reset                         Restore default theme
`)
    return
  }

  if (command === "list") {
    for (const theme of getPresetThemes()) console.log(`${theme.id}\t${theme.name}`)
    return
  }
  if (command === "detect") {
    console.table(detectThemeDirectories())
    return
  }
  if (command === "create") {
    const theme = createThemeJson({ id: rest[0], name: rest[1] })
    saveTheme(getOption(rest, "out") || `${theme.id}.json`, theme)
    console.log(`已生成主题：${theme.id}`)
    return
  }
  if (command === "import") {
    const theme = loadTheme(rest[0])
    const destination = getOption(rest, "out") || defaultThemePath(theme.id)
    saveTheme(destination, theme)
    console.log(`已导入主题：${destination}`)
    return
  }
  if (command === "set-color") {
    const theme = loadTheme(rest[0])
    saveTheme(rest[0], updateThemeColor(theme, rest[1], rest[2], rest[3]))
    console.log(`已更新 ${rest[1]} 配色：${rest[2]}`)
    return
  }
  if (command === "export") {
    const theme = getPresetThemes().find((item) => item.id === rest[0])
    if (!theme) throw new Error(`找不到预设主题：${rest[0]}`)
    const destination = getOption(rest, "out") || `${theme.id}.json`
    saveTheme(destination, theme)
    console.log(`已导出主题：${destination}`)
    return
  }
  if (command === "contrast") {
    for (const result of checkContrast(loadTheme(rest[0]))) {
      console.log(`${result.mode}: ${result.foreground} / ${result.background} = ${result.ratio}:1，AA ${result.aaNormal ? "通过" : "不通过"}`)
    }
    return
  }
  if (command === "apply") {
    const themePath = rest[0]
    if (!themePath) throw new Error("请指定主题文件路径")
    console.log("Loading theme from:", themePath)
    const script = buildThemeScriptFromFile(themePath)
    console.log("Theme script length:", script.length)

    console.log("\nConnecting to OpenCode Desktop via CDP...")
    const port = getOption(rest, "port") ? parseInt(getOption(rest, "port"), 10) : 19222
    const target = await findRendererTarget(port, 10000)
    console.log("  Target:", target.title || "(untitled)")

    const session = await connectCDP(target)
    console.log("  Connected")

    await enableDomains(session)
    setupConsoleCapture(session)

    // Remove old theme scripts
    try {
      const result = await session.send("Page.getScriptsToEvaluateOnNewDocument")
      for (const s of result.scripts) {
        if (s.source.includes("__OPENCODE_ZH_THEME__")) {
          await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: s.identifier })
        }
      }
    } catch {
      // Older Electron versions may not expose script enumeration.
    }

    // Inject persistent + immediate
    const id = await injectPersistentScript(session, script)
    console.log("  Theme script injected (id:", id + ")")
    await evaluateScript(session, script)
    console.log("  Theme applied successfully")

    session.close()
    console.log("\nDone. Theme will persist across navigations.")
    return
  }
  if (command === "preview") {
    const themePath = rest[0]
    if (!themePath) throw new Error("请指定主题文件路径")
    const theme = loadTheme(themePath)
    console.log(`Theme: ${theme.name} (${theme.id})`)
    console.log("\n--- Light mode CSS ---")
    const lightEntries = Object.entries(theme.light.overrides ?? {})
    if (lightEntries.length === 0) {
      console.log("  (no overrides)")
    } else {
      console.log(":root {")
      for (const [k, v] of lightEntries) {
        console.log(`  --${k}: ${v};`)
      }
      console.log("}")
    }
    console.log("\n--- Dark mode CSS ---")
    const darkEntries = Object.entries(theme.dark.overrides ?? {})
    if (darkEntries.length === 0) {
      console.log("  (no overrides)")
    } else {
      console.log(":root {")
      for (const [k, v] of darkEntries) {
        console.log(`  --${k}: ${v};`)
      }
      console.log("}")
    }
    for (const [mode, variant] of [["light", theme.light], ["dark", theme.dark]]) {
      if (variant.visuals) console.log(`\n--- ${mode} visual config ---\n${JSON.stringify(variant.visuals, null, 2)}`)
    }
    if (theme.pages && Object.keys(theme.pages).length > 0) {
      console.log(`\n--- Page visual config ---\n${JSON.stringify(theme.pages, null, 2)}`)
    }
    return
  }
  if (command === "assets") {
    const themePath = rest[0]
    if (!themePath) throw new Error("请指定主题文件路径")
    const theme = loadTheme(themePath)
    const baseDirectory = dirname(themePath)
    const assets = []
    for (const [mode, variant] of [["light", theme.light], ["dark", theme.dark]]) {
      const image = variant.visuals?.backgroundImage
      if (!image || /^(?:data:|https?:|file:)/i.test(image)) {
        if (image) assets.push(`${mode}: ${image}（外部或内嵌资源）`)
        continue
      }
      const resolved = join(baseDirectory, image)
      assets.push(`${mode}: ${resolved}（${existsSync(resolved) ? "存在" : "缺失"}）`)
    }
    for (const [page, config] of Object.entries(theme.pages ?? {})) {
      if (config?.backgroundImage) assets.push(`page:${page}: ${config.backgroundImage}`)
    }
    console.log(assets.length ? assets.join("\n") : "主题未配置背景资源")
    return
  }
  if (command === "reset") {
    const restored = restoreDefaultTheme(getOption(rest, "project"))
    try {
      const port = getOption(rest, "port") ? parseInt(getOption(rest, "port"), 10) : 19222
      const target = await findRendererTarget(port, 1000)
      const session = await connectCDP(target)
      await enableDomains(session)
      await evaluateScript(session, buildThemeCleanupScript())
      session.close()
      console.log("已清理当前运行中的主题注入")
    } catch {
      console.log("当前未连接到 Desktop，仅完成主题文件恢复")
    }
    console.log(restored.length ? `已恢复默认主题，停用文件：${restored.join(", ")}` : "未找到由主题管理器写入的 theme.json")
    return
  }
  throw new Error(`未知主题命令：${command}`)
}

function getOption(args, name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

function defaultThemePath(id) {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd()
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config")
  return join(config, "opencode", "desktop-themes", "theme.json")
}

main().catch((err) => {
  console.error("Error:", err.message)
  process.exit(1)
})
