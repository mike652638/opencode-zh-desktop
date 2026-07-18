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
 *   --help, -h          Show help
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { launchDesktop, findDesktopExe } from "../dist/launcher.js"
import { findRendererTarget, connectCDP, injectPersistentScript, evaluateScript, enableDomains, setupConsoleCapture } from "../dist/connector.js"
import { buildInjectionScript } from "../dist/inject.js"
import { startDaemon } from "../dist/daemon.js"

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

  if (opts.daemon) {
    await startDaemon({ port: opts.port, exePath: opts.exe })
    return
  }

  console.log("opencode-zh-desktop — CDP Chinese locale injection for OpenCode Desktop\n")

  let port = opts.port

  if (!opts.noRelaunch) {
    console.log("Step 1: Launching OpenCode Desktop with CDP...")
    const result = await launchDesktop({ port, exePath: opts.exe })
    port = result.port
    console.log("  PID:", result.pid)
    console.log("  Port:", port)
    console.log("  Exe:", result.exePath)
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
  const opts = { port: 19222, exe: undefined, noRelaunch: false, help: false, daemon: false, version: false }
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        opts.port = parseInt(args[++i], 10)
        break
      case "--exe":
        opts.exe = args[++i]
        break
      case "--no-relaunch":
        opts.noRelaunch = true
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
  --no-relaunch       Connect to existing instance instead of relaunching
  --daemon            Run in daemon mode (auto-restart, hot-reload, reconnect)
  --version, -v       Show version
  --help, -h          Show this help

Description:
  Launches OpenCode Desktop with Chrome DevTools Protocol enabled,
  then injects a script that:
  1. Sets the locale to Chinese (zh)
  2. Replaces remaining English text in the DOM with Chinese translations

  With --daemon, runs as a long-lived process that:
  - Auto-restarts Desktop if it crashes
  - Reconnects with exponential backoff on disconnect
  - Hot-reloads the injection script on file changes
`)
}

main().catch((err) => {
  console.error("Error:", err.message)
  process.exit(1)
})
