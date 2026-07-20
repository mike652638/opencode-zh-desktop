/**
 * Daemon mode: Long-running process that monitors OpenCode Desktop,
 * auto-injects translations, handles reconnection with exponential backoff,
 * auto-restarts on crash, and supports hot-reloading the translation script.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs"
import process from "node:process"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { launchDesktop, waitForCDP } from "./launcher.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
import {
  findRendererTarget,
  connectCDP,
  injectPersistentScript,
  removeMatchingPersistentScripts,
  removePersistentScript,
  evaluateScript,
  enableDomains,
  setupConsoleCapture,
  type CDPSession,
} from "./connector.js"
import { buildInjectionScript } from "./inject.js"
import { buildThemeCleanupScript, buildThemeScriptFromFile } from "./theme-injector.js"

export interface DaemonOptions {
  /** CDP port (default: 19222) */
  port?: number
  /** Path to OpenCode Desktop executable */
  exePath?: string
  /** Remove proxy environment variables from the Desktop child process. */
  noProxy?: boolean
  /** Poll interval in ms (default: 5000) */
  pollInterval?: number
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number
  /** Path to a DesktopTheme JSON file to inject as CSS variable overrides. */
  themePath?: string
}

interface DaemonState {
  port: number
  exePath?: string
  noProxy: boolean
  pollInterval: number
  maxReconnectDelay: number
  session: CDPSession | null
  reconnectDelay: number
  running: boolean
  injectionScript: string
  watchers: ReturnType<typeof watch>[]
  restartFailCount: number
  standby: boolean
  /** Mutex: prevents concurrent restart attempts from poll timer + scheduleReconnect */
  restarting: boolean
  /** Mutex: prevents overlapping renderer connection and injection attempts. */
  connecting: boolean
  /** Persistent script registered on the current renderer target. */
  persistentScriptId: string | null
  /** Theme injection script (null if no theme file specified). */
  themeScript: string | null
  /** Persistent script ID for the theme injection. */
  persistentThemeScriptId: string | null
  /** Path to the theme file being watched. */
  themePath: string | null
}

const MAX_RESTART_FAILURES = 3

interface DaemonLock {
  path: string
  wakePath: string
  fd: number
}

class DaemonAlreadyRunningError extends Error {
  constructor(public readonly port: number, public readonly ownerPid: number) {
    super(`Another daemon is already running for CDP port ${port} (PID ${ownerPid})`)
    this.name = "DaemonAlreadyRunningError"
  }
}

function acquireDaemonLock(port: number): DaemonLock {
  const lockPath = path.join(os.tmpdir(), `opencode-zh-desktop-${port}.lock`)

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx")
      writeFileSync(fd, String(process.pid))
      try { unlinkSync(`${lockPath}.wake`) } catch { /* no pending wake request */ }
      return { path: lockPath, wakePath: `${lockPath}.wake`, fd }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

      let ownerPid = 0
      try {
        ownerPid = Number.parseInt(readFileSync(lockPath, "utf8"), 10)
      } catch {
        // The lock may be between creation and PID write.
      }

      if (ownerPid <= 0) {
        throw new Error(`Another daemon is starting for CDP port ${port}`)
      }

      try {
        process.kill(ownerPid, 0)
        throw new DaemonAlreadyRunningError(port, ownerPid)
      } catch (probeErr) {
        if (probeErr instanceof DaemonAlreadyRunningError) throw probeErr
      }

      if (!existsSync(lockPath)) continue
      try {
        unlinkSync(lockPath)
      } catch {
        throw new Error(`Another daemon is starting for CDP port ${port}`)
      }
    }
  }
}

function releaseDaemonLock(lock: DaemonLock): void {
  try { closeSync(lock.fd) } catch { /* already closed */ }
  try { unlinkSync(lock.path) } catch { /* stale lock cleanup is best effort */ }
}

function requestDaemonWake(port: number): void {
  const wakePath = path.join(os.tmpdir(), `opencode-zh-desktop-${port}.lock.wake`)
  writeFileSync(wakePath, String(Date.now()))
}

function consumeDaemonWake(lock: DaemonLock): boolean {
  if (!existsSync(lock.wakePath)) return false
  try {
    unlinkSync(lock.wakePath)
    return true
  } catch {
    return false
  }
}

async function checkCDPAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function connectAndInject(state: DaemonState): Promise<CDPSession | null> {
  if (state.connecting) return null
  state.connecting = true
  let session: CDPSession | null = null
  try {
    console.log("[daemon] Finding renderer target...")
    const target = await findRendererTarget(state.port, 10000)

    console.log("[daemon] Connecting via WebSocket...")
    session = await connectCDP(target)

    console.log("[daemon] Enabling CDP domains...")
    await enableDomains(session)
    setupConsoleCapture(session)

    console.log("[daemon] Injecting translation script...")
    try {
      await removeMatchingPersistentScripts(session, "__OPENCODE_ZH_INJECTION__")
    } catch {
      // Older Electron versions may not expose script enumeration.
    }
    if (state.persistentScriptId) {
      try {
        await removePersistentScript(session, state.persistentScriptId)
      } catch {
        // The old identifier may belong to a previous renderer target.
      }
      state.persistentScriptId = null
    }
    state.persistentScriptId = await injectPersistentScript(session, state.injectionScript)

    console.log("[daemon] Running injection on current page...")
    await evaluateScript(session, state.injectionScript)

    // Inject theme CSS overrides if a theme file is configured
    if (state.themeScript) {
      console.log("[daemon] Injecting theme CSS overrides...")
      try {
        await removeMatchingPersistentScripts(session, "__OPENCODE_ZH_THEME__")
      } catch {
        // Older Electron versions may not expose script enumeration.
      }
      if (state.persistentThemeScriptId) {
        try {
          await removePersistentScript(session, state.persistentThemeScriptId)
        } catch {
          // The old identifier may belong to a previous renderer target.
        }
        state.persistentThemeScriptId = null
      }
      state.persistentThemeScriptId = await injectPersistentScript(session, state.themeScript)
      await evaluateScript(session, state.themeScript)
      console.log("[daemon] Theme injection complete")
    }

    console.log("[daemon] Injection complete")
    state.reconnectDelay = 1000

    session.ws.addEventListener("close", () => {
      console.log("[daemon] WebSocket closed")
      state.session = null
      scheduleReconnect(state)
    })

    session.ws.addEventListener("error", () => {
      console.log("[daemon] WebSocket error")
      state.session = null
    })

    return session
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[daemon] Connect/inject failed:", msg)
    try { session?.close() } catch { /* ignore failed connection cleanup */ }
    return null
  } finally {
    state.connecting = false
  }
}

function scheduleReconnect(state: DaemonState): void {
  if (!state.running || state.session || state.restarting || state.connecting || state.standby) return

  console.log(`[daemon] Reconnecting in ${state.reconnectDelay}ms...`)
  setTimeout(async () => {
    if (!state.running || state.session || state.restarting || state.connecting || state.standby) return

    const alive = await checkCDPAlive(state.port)
    if (!alive) {
      console.log("[daemon] CDP not available, attempting restart...")
      await tryRestartDesktop(state)
      return
    }

    const session = await connectAndInject(state)
    if (session) {
      state.session = session
    } else {
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, state.maxReconnectDelay)
      scheduleReconnect(state)
    }
  }, state.reconnectDelay)
}

async function tryRestartDesktop(state: DaemonState): Promise<void> {
  if (!state.running || state.restarting || state.standby) return
  state.restarting = true

  try {
    console.log("[daemon] Waiting 5s before restarting Desktop...")
    await new Promise((r) => setTimeout(r, 5000))
    if (!state.running) return

    console.log("[daemon] Restarting OpenCode Desktop...")
    const result = await launchDesktop({
      port: state.port,
      exePath: state.exePath,
      noProxy: state.noProxy,
      onExit: (code, signal) => handleDesktopExit(state, code, signal),
    })
    console.log("[daemon] Desktop restarted, PID:", result.pid)
    state.restartFailCount = 0

    await waitForCDP(state.port, 30000)
    const session = await connectAndInject(state)
    if (session) {
      state.session = session
    } else {
      scheduleReconnect(state)
    }
  } catch (err) {
    state.restartFailCount++
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[daemon] Restart failed (${state.restartFailCount}/${MAX_RESTART_FAILURES}):`, msg)

    if (state.restartFailCount >= MAX_RESTART_FAILURES) {
      console.log("[daemon] Too many restart failures — entering standby mode")
      console.log("[daemon] Please start OpenCode Desktop manually, or run with --exe <path>")
      state.standby = true
      state.reconnectDelay = 30000
      scheduleReconnect(state)
    } else {
      scheduleReconnect(state)
    }
  } finally {
    state.restarting = false
  }
}

function handleDesktopExit(
  state: DaemonState,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (!state.running) return

  if (code === 0 && signal === null) {
    state.standby = true
    state.session = null
    console.log("[daemon] Desktop closed normally; auto-restart paused")
    console.log("[daemon] Start OpenCode Desktop again to resume injection")
    return
  }

  console.log(
    `[daemon] Desktop exited unexpectedly (code: ${code ?? "null"}, signal: ${signal ?? "none"}); auto-restart remains enabled`,
  )
}

function setupHotReload(state: DaemonState): void {
  const watchPath = path.join(__dirname, "injection", "script.js")
  try {
    const watcher = watch(watchPath, { recursive: false }, async (eventType) => {
      if (eventType !== "change") return
      console.log("[daemon] Injection script changed, reloading...")
      try {
        state.injectionScript = buildInjectionScript()
        console.log("[daemon] Script reloaded, length:", state.injectionScript.length)

        if (state.session) {
          try {
            if (state.persistentScriptId) {
              await removePersistentScript(state.session, state.persistentScriptId).catch(() => {})
              state.persistentScriptId = null
            }
            state.persistentScriptId = await injectPersistentScript(state.session, state.injectionScript)
            await evaluateScript(state.session, state.injectionScript)
            console.log("[daemon] Script re-injected into renderer")
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("[daemon] Re-injection failed:", msg)
            state.session = null
            scheduleReconnect(state)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[daemon] Script reload failed:", msg)
      }
    })
    state.watchers.push(watcher)
  } catch {
    // File might not exist yet
  }

  // Watch theme file for hot-reload
  if (state.themePath) {
    try {
      const themeFileName = path.basename(state.themePath)
      const themeWatcher = watch(path.dirname(state.themePath), { recursive: false }, async (eventType, changedFile) => {
        if (eventType !== "change" && eventType !== "rename") return
        if (changedFile && String(changedFile) !== themeFileName) return
        console.log("[daemon] Theme file changed, reloading...")
        try {
          if (!existsSync(state.themePath!)) {
            state.themeScript = null
            if (state.session) {
              await evaluateScript(state.session, buildThemeCleanupScript())
              if (state.persistentThemeScriptId) {
                await removePersistentScript(state.session, state.persistentThemeScriptId).catch(() => {})
                state.persistentThemeScriptId = null
              }
            }
            console.log("[daemon] Theme file removed, default appearance restored")
            return
          }
          state.themeScript = buildThemeScriptFromFile(state.themePath!)
          console.log("[daemon] Theme script reloaded, length:", state.themeScript.length)

          if (state.session) {
            try {
              if (state.persistentThemeScriptId) {
                await removePersistentScript(state.session, state.persistentThemeScriptId).catch(() => {})
                state.persistentThemeScriptId = null
              }
              state.persistentThemeScriptId = await injectPersistentScript(state.session, state.themeScript)
              await evaluateScript(state.session, state.themeScript)
              console.log("[daemon] Theme re-injected into renderer")
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              console.error("[daemon] Theme re-injection failed:", msg)
              state.session = null
              scheduleReconnect(state)
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error("[daemon] Theme reload failed:", msg)
        }
      })
      state.watchers.push(themeWatcher)
    } catch {
      // Theme file might not exist yet
    }
  }
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  const port = opts.port ?? 19222
  let lock: DaemonLock
  try {
    lock = acquireDaemonLock(port)
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      requestDaemonWake(port)
      console.log(`[daemon] Existing daemon found (PID ${err.ownerPid}); wake request sent`)
      return
    }
    throw err
  }
  const state: DaemonState = {
    port,
    exePath: opts.exePath,
    noProxy: opts.noProxy ?? false,
    pollInterval: opts.pollInterval ?? 5000,
    maxReconnectDelay: opts.maxReconnectDelay ?? 30000,
    session: null,
    reconnectDelay: 1000,
    running: true,
    injectionScript: "",
    watchers: [],
    restartFailCount: 0,
    standby: false,
    restarting: false,
    connecting: false,
    persistentScriptId: null,
    themeScript: null,
    persistentThemeScriptId: null,
    themePath: opts.themePath ?? null,
  }

  console.log("[daemon] Starting daemon mode on port", state.port)

  state.injectionScript = buildInjectionScript()
  console.log("[daemon] Injection script loaded, length:", state.injectionScript.length)

  // Load theme script if a theme file path was provided
  if (state.themePath) {
    try {
      state.themeScript = buildThemeScriptFromFile(state.themePath)
      console.log("[daemon] Theme script loaded, length:", state.themeScript.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[daemon] Failed to load theme file:", msg)
      console.log("[daemon] Continuing without theme injection")
      state.themePath = null
    }
  }

  const alive = await checkCDPAlive(state.port)
  if (alive) {
    console.log("[daemon] Found existing Desktop instance")
    const session = await connectAndInject(state)
    if (session) {
      state.session = session
    } else {
      scheduleReconnect(state)
    }
  } else {
    console.log("[daemon] No Desktop instance found, launching...")
    try {
      const result = await launchDesktop({
        port: state.port,
        exePath: state.exePath,
        noProxy: state.noProxy,
        onExit: (code, signal) => handleDesktopExit(state, code, signal),
      })
      console.log("[daemon] Desktop launched, PID:", result.pid)
      await waitForCDP(state.port, 30000)
      const session = await connectAndInject(state)
      if (session) {
        state.session = session
      } else {
        scheduleReconnect(state)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[daemon] Launch failed:", msg)
      scheduleReconnect(state)
    }
  }

  setupHotReload(state)

  const poll = async () => {
    if (!state.running) return
    try {
      if (state.standby && consumeDaemonWake(lock)) {
        console.log("[daemon] Wake request received; resuming Desktop monitoring")
        state.standby = false
        state.restartFailCount = 0
        state.reconnectDelay = 1000
      }

      const isAlive = await checkCDPAlive(state.port)
      if (isAlive) {
        if (state.standby) {
          console.log("[daemon] Desktop detected! Resuming normal operation...")
          state.standby = false
          state.restartFailCount = 0
          state.reconnectDelay = 1000
        }
        if (!state.session && !state.restarting && !state.connecting) {
          const session = await connectAndInject(state)
          if (session) state.session = session
        }
      } else if (!state.session && !state.standby && !state.restarting) {
        console.log("[daemon] Desktop not running, attempting restart...")
        await tryRestartDesktop(state)
      }
    } catch {
      // Poll errors are non-fatal
    }
    if (state.running) {
      setTimeout(poll, state.standby ? 1000 : state.pollInterval)
    }
  }
  setTimeout(poll, state.pollInterval)

  const shutdown = async () => {
    console.log("\n[daemon] Shutting down...")
    state.running = false
    for (const w of state.watchers) w.close()
    if (state.session) {
      try { state.session.close() } catch { /* ignore */ }
    }
    releaseDaemonLock(lock)
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("exit", () => releaseDaemonLock(lock))

  await new Promise(() => {})
}
