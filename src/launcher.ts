/**
 * Launcher: Find OpenCode Desktop exe, kill existing instances,
 * and relaunch with --remote-debugging-port for CDP access.
 */

import { exec, spawn } from "node:child_process"
import { promisify } from "node:util"
import process from "node:process"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const execAsync = promisify(exec)

export interface LaunchOptions {
  port?: number
  exePath?: string
  timeout?: number
  forceRelaunch?: boolean
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface LaunchResult {
  pid: number
  port: number
  exePath: string
  reused: boolean
}

/** Find the OpenCode Desktop executable on the current platform. */
export async function findDesktopExe(): Promise<string | null> {
  const platform = process.platform
  const home = os.homedir()

  if (platform === "win32") {
    const candidates = [
      path.join(home, "AppData", "Local", "Programs", "@opencode-ai", "OpenCode.exe"),
      path.join(home, "AppData", "Local", "Programs", "@opencode-aidesktop", "OpenCode.exe"),
      path.join(home, "AppData", "Local", "opencode-desktop", "OpenCode.exe"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  } else if (platform === "darwin") {
    const candidates = [
      "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
      path.join(home, "Applications", "OpenCode.app", "Contents", "MacOS", "OpenCode"),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  } else if (platform === "linux") {
    const candidates = [
      "/usr/bin/opencode-desktop",
      "/usr/local/bin/opencode-desktop",
      path.join(home, ".local", "bin", "opencode-desktop"),
      "/opt/OpenCode/opencode-desktop",
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  }

  return null
}

/** Kill all running OpenCode Desktop instances.
 *  First checks if any instance is running to avoid unnecessary taskkill
 *  (which triggers Windows error sounds on non-existent processes).
 *  Uses graceful kill first (WM_CLOSE), then force kill as fallback. */
export async function killDesktop(): Promise<void> {
  const platform = process.platform

  // Check if any instance is running first — skip kill if none exists
  try {
    if (platform === "win32") {
      const { stdout } = await execAsync("tasklist /FI \"IMAGENAME eq OpenCode.exe\" /NH", { timeout: 3000 })
      if (stdout.includes("No tasks")) return
    } else if (platform === "darwin") {
      await execAsync("pgrep -f 'OpenCode.app'", { timeout: 3000 })
    } else {
      await execAsync("pgrep -f opencode-desktop", { timeout: 3000 })
    }
  } catch {
    return // Process not running — nothing to kill
  }

  try {
    if (platform === "win32") {
      // Graceful kill first — sends WM_CLOSE, avoids EPIPE error dialogs
      await execAsync("taskkill /IM OpenCode.exe", { timeout: 5000 }).catch(() => {})
      await sleep(2000)
      // Force kill any remaining instances
      await execAsync("taskkill /F /IM OpenCode.exe", { timeout: 5000 }).catch(() => {})
    } else if (platform === "darwin") {
      await execAsync("pkill -f 'OpenCode.app'", { timeout: 5000 })
    } else {
      await execAsync("pkill -f opencode-desktop", { timeout: 5000 })
    }
  } catch {
    // Process may have exited during kill — that's fine
  }
  await sleep(3000)
}

/** Launch OpenCode Desktop with remote debugging enabled.
 *  Uses detached spawn with stdio ignored to avoid EPIPE errors from broken pipes. */
export async function launchDesktop(opts: LaunchOptions = {}): Promise<LaunchResult> {
  const port = opts.port ?? 19222
  const timeout = opts.timeout ?? 30000

  // Reusing a live CDP instance avoids restarting Desktop's PTY service.
  // Restarting it while the TUI is active can leak mouse/VT sequences.
  if (!opts.forceRelaunch && await isCDPAvailable(port)) {
    return {
      pid: 0,
      port,
      exePath: opts.exePath ?? "",
      reused: true,
    }
  }

  let exePath: string | undefined = opts.exePath
  if (!exePath) {
    const found = await findDesktopExe()
    if (found) exePath = found
  }
  if (!exePath) {
    throw new Error(
      "OpenCode Desktop not found. Please provide --exe-path or install OpenCode Desktop."
    )
  }

  await killDesktop()

  const args = [`--remote-debugging-port=${port}`]
  const child = spawn(exePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  })
  if (opts.onExit) {
    child.once("exit", opts.onExit)
  }
  child.unref()

  await waitForCDP(port, timeout)

  return {
    pid: child.pid ?? 0,
    port,
    exePath,
    reused: false,
  }
}

/** Check whether an existing Desktop instance exposes the requested CDP port. */
async function isCDPAvailable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Wait for the CDP HTTP endpoint to respond. */
export async function waitForCDP(port: number, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/version`)
      if (res.ok) return
    } catch {
      // Not ready yet
    }
    await sleep(500)
  }
  throw new Error(`CDP endpoint not available on port ${port} after ${timeout}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
