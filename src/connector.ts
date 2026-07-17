/**
 * CDP Connector: Connect to Electron via Chrome DevTools Protocol.
 * Find the renderer target, inject scripts via Page.addScriptToEvaluateOnNewDocument
 * and Runtime.evaluate.
 */

export interface CDPTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export interface CDPSession {
  target: CDPTarget
  ws: WebSocket
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  close(): void
}

/** Get the list of CDP targets from the HTTP endpoint. */
export async function getTargets(port: number): Promise<CDPTarget[]> {
  const res = await fetch("http://localhost:" + port + "/json")
  if (!res.ok) throw new Error("Failed to get CDP targets: " + res.status)
  return await res.json() as CDPTarget[]
}

/** Find the renderer target (type: "page"). */
export async function findRendererTarget(port: number, timeout = 30000): Promise<CDPTarget> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const targets = await getTargets(port)
    const page = targets.find(t => t.type === "page")
    if (page) return page
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error("No renderer (page) target found within timeout")
}

/** Connect to a CDP target via WebSocket. */
export async function connectCDP(target: CDPTarget): Promise<CDPSession> {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true })
  })

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let messageId = 0

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data as string)
    if (data.id && pending.has(data.id)) {
      const p = pending.get(data.id)!
      pending.delete(data.id)
      if (data.error) p.reject(new Error(data.error.message))
      else p.resolve(data.result)
    }
  })

  const session: CDPSession = {
    target,
    ws,
    async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      const id = ++messageId
      const msg = JSON.stringify({ id, method, params: params || {} })
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        if (ws.readyState !== ws.OPEN) {
          reject(new Error("WebSocket is not open"))
          return
        }
        ws.send(msg)
      })
    },
    close() { ws.close() },
  }

  return session
}

/** Inject a script that runs on every new document (before page scripts). */
export async function injectPersistentScript(session: CDPSession, script: string): Promise<string> {
  const result = await session.send<{ identifier: string }>(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: script }
  )
  return result.identifier
}

/** Evaluate a script in the current page context. */
export async function evaluateScript<T = unknown>(session: CDPSession, expression: string): Promise<T> {
  const result = await session.send<{
    result: { type: string; value: T }
    exceptionDetails?: { text: string; exception?: { description?: string; value?: string } }
  }>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true }
  )
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text
    throw new Error("Script evaluation exception: " + desc)
  }
  return result.result.value
}

/** Enable required CDP domains. */
export async function enableDomains(session: CDPSession): Promise<void> {
  await session.send("Page.enable")
  await session.send("Runtime.enable")
}

/** Subscribe to console and exception events from the renderer. */
export function setupConsoleCapture(session: CDPSession): void {
  session.ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data as string)
    if (data.method === "Runtime.consoleAPICalled") {
      const args = data.params?.args || []
      const msg = args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description ?? "").join(" ")
      console.log("  [renderer console]", msg)
    }
    if (data.method === "Runtime.exceptionThrown") {
      const details = data.params?.exceptionDetails
      if (details) {
        console.error("  [renderer ERROR]", details.text)
        if (details.exception) {
          console.error("   ", details.exception.description || details.exception.value || "")
        }
      }
    }
  })
}
