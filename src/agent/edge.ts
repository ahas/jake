// The real browser backend: Microsoft Edge, launched with a remote-debugging endpoint and driven
// over CDP. This is the whole reason the browser capability can live inside the compiled agent now —
// nothing here is bundled that a compile cannot carry, and no browser is downloaded. Edge is already
// on 하스's Windows box; the agent starts it in debugging mode, connects one WebSocket, opens one
// page, and speaks CDP to it. When Edge is not found, the backend reports itself unavailable and no
// browser capability is advertised. docs/architecture.md is the canonical statement of this shape.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserDriver, FetchParams, NavigateParams, WaitUntil } from "./browser-ops";
import type { BrowserBackend, BrowserSession } from "./browser";
import { CdpConnection, WebSocketCdpDialer, type CdpDialer } from "./cdp";
import type { Logger } from "./log";

/** One launched Edge, seen the way the backend needs it. Injected so a fake stands in for the real one. */
export interface EdgeProcess {
  /** Resolve with the browser-level CDP WebSocket URL once the debugging endpoint is up, else reject. */
  debuggerUrl(): Promise<string>;
  /** Settles when the Edge process ends, however it ended. */
  readonly exited: Promise<{ code: number | null }>;
  /** End Edge and clean up its throwaway profile. Calling it more than once is harmless. */
  kill(): void;
}

/** Locates and launches Edge. `locate` returns null when Edge is not installed on this machine. */
export interface EdgeLauncher {
  /** The Edge (or Edge-compatible) executable path, or null when none is found here. */
  locate(): string | null;
  /** Launch Edge in debugging mode. The caller only calls this when `locate` returned a path. */
  launch(): EdgeProcess;
}

/** What the real Edge launcher needs: an optional explicit path, whether to run headless, and the log. */
export interface EdgeLauncherOptions {
  /** An explicit executable path — an Edge, or a Chromium/Chrome the tests point at — bypassing the search. */
  executablePath: string | null;
  /** Whether to run Edge headless. A headless run needs no interactive desktop and shows no window. */
  headless: boolean;
  /** How long to wait for Edge's debugging endpoint to come up before giving up, in milliseconds. */
  startupTimeoutMs: number;
  log: Logger;
}

// The standard per-machine locations Edge installs to on Windows. The agent searches these when no
// explicit path is configured; the first that exists is used.
function windowsEdgePaths(env: Record<string, string | undefined>): string[] {
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(
    (root): root is string => root !== undefined && root !== "",
  );
  return roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
}

/**
 * The real Edge launcher on 하스's box. It finds msedge.exe — a configured path first, then the
 * standard per-machine install locations — and launches it with a remote-debugging port chosen by
 * the OS, a throwaway user-data directory so it never touches 하스's own Edge profile, and the flags
 * that keep an unattended launch from prompting. The chosen port is read back from the
 * DevToolsActivePort file Edge writes into that directory, which also carries the browser endpoint's
 * path, so the backend learns the exact WebSocket URL to dial.
 */
export function realEdgeLauncher(options: EdgeLauncherOptions, env: Record<string, string | undefined> = process.env): EdgeLauncher {
  const locate = (): string | null => {
    if (options.executablePath !== null && options.executablePath !== "" && existsSync(options.executablePath)) {
      return options.executablePath;
    }
    if (process.platform === "win32") {
      for (const candidate of windowsEdgePaths(env)) {
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };

  return {
    locate,
    launch(): EdgeProcess {
      const exe = locate();
      if (exe === null) {
        throw new Error("Edge was not found on this machine");
      }
      const userDataDir = mkdtempSync(join(tmpdir(), "jake-edge-"));
      const args = [
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--no-sandbox",
        ...(options.headless ? ["--headless=new"] : []),
        "about:blank",
      ];
      const proc = Bun.spawn([exe, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      options.log.log("info", "edge-launched", { exe, headless: options.headless });
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // best effort; a throwaway profile the OS will reap anyway
        }
      };
      void proc.exited.then(cleanup);
      return {
        debuggerUrl: () => readDebuggerUrl(userDataDir, options.startupTimeoutMs),
        exited: proc.exited.then(() => ({ code: proc.exitCode })),
        kill: () => {
          try {
            proc.kill();
          } catch {
            // already gone
          }
          cleanup();
        },
      };
    },
  };
}

/**
 * Read the browser-level CDP WebSocket URL from the DevToolsActivePort file Edge writes into its
 * user-data directory once the debugging endpoint is up. The file's first line is the chosen port and
 * its second line is the browser endpoint's path, so the two compose the loopback URL to dial. The
 * file appears a moment after launch, so it is polled until it is complete or the timeout is reached.
 */
async function readDebuggerUrl(userDataDir: string, timeoutMs: number): Promise<string> {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(portFile, "utf8");
      const lines = text.split("\n");
      const port = lines[0]?.trim();
      const path = lines[1]?.trim();
      if (port !== undefined && port !== "" && path !== undefined && path !== "") {
        return `ws://127.0.0.1:${port}${path}`;
      }
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`Edge did not open its debugging endpoint within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The decoded byte length of a base64 string, without decoding it. */
function base64ByteLength(base64: string): number {
  if (base64 === "") return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * The CDP-backed driver over one attached page session. Every method issues CDP commands on that
 * session; a navigation's HTTP status is captured from the Network events the session emits, keyed by
 * the navigation's loader id. A CDP error the endpoint returns, or the socket going away, surfaces as
 * a thrown error the dispatch turns into a driver-error the agent relays intact.
 */
class CdpBrowserDriver implements BrowserDriver {
  private readonly documentStatus = new Map<string, number>();

  constructor(
    private readonly conn: CdpConnection,
    private readonly sessionId: string,
  ) {
    // Record the HTTP status of every top-level document response, so a navigate can report the
    // status its loader id saw. Sub-resource responses are ignored; only Document type is kept.
    this.conn.on("Network.responseReceived", this.sessionId, (params) => {
      if (params.type !== "Document") return;
      const loaderId = params.loaderId;
      const response = params.response;
      if (typeof loaderId === "string" && isRecord(response) && typeof response.status === "number") {
        this.documentStatus.set(loaderId, response.status);
      }
    });
  }

  async navigate(params: NavigateParams): Promise<{ url: string; status: number | null }> {
    // Register the lifecycle waiter before navigating, so the load event cannot fire in the gap
    // between the navigate command returning and the wait beginning.
    const lifecycle = this.waitForLifecycle(params.waitUntil, params.timeoutMs);
    const nav = await this.conn.send("Page.navigate", { url: params.url }, this.sessionId);
    if (typeof nav.errorText === "string" && nav.errorText !== "") {
      throw new Error(`navigation failed: ${nav.errorText}`);
    }
    const loaderId = typeof nav.loaderId === "string" ? nav.loaderId : null;
    await lifecycle;
    const status = loaderId !== null && this.documentStatus.has(loaderId) ? this.documentStatus.get(loaderId)! : null;
    return { url: await this.currentUrl(), status };
  }

  async source(): Promise<{ url: string; html: string }> {
    const html = await this.evaluate({ expression: "document.documentElement.outerHTML" });
    return { url: await this.currentUrl(), html: typeof html.value === "string" ? html.value : String(html.value ?? "") };
  }

  async shot(params: { fullPage: boolean }): Promise<{ png: string; bytes: number }> {
    let clip: Record<string, number> | undefined;
    if (params.fullPage) {
      const metrics = await this.conn.send("Page.getLayoutMetrics", {}, this.sessionId);
      const size = isRecord(metrics.cssContentSize)
        ? metrics.cssContentSize
        : isRecord(metrics.contentSize)
          ? metrics.contentSize
          : null;
      if (size !== null && typeof size.width === "number" && typeof size.height === "number") {
        clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
    }
    // Edge intermittently answers the very first capture after a navigation with a transient protocol
    // error while the compositor settles. It clears on a retry, so a few attempts with a short pause
    // precede surfacing the failure.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const request: Record<string, unknown> = { format: "png" };
        if (clip !== undefined) {
          request.clip = clip;
          request.captureBeyondViewport = true;
        }
        const result = await this.conn.send("Page.captureScreenshot", request, this.sessionId);
        const data = typeof result.data === "string" ? result.data : "";
        return { png: data, bytes: base64ByteLength(data) };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError;
  }

  async evaluate(params: { expression: string }): Promise<{ value: unknown }> {
    // Wrap the expression as an immediately-invoked function, so a bare expression such as
    // "document.title" and an IIFE both work, and await a promise result so an async expression
    // resolves before the value is read.
    return { value: await this.runExpression(`(() => (${params.expression}))()`, true) };
  }

  async fetch(params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    // The fetch runs inside the page, so the page's origin, cookies, and session apply — the point of
    // a page-context fetch over the agent's own top-level fetch. The body is read as text and capped,
    // so a large response is truncated rather than pulled whole across the connection.
    const expression = `(async () => {
      const init = { method: ${JSON.stringify(params.method)}, headers: ${JSON.stringify(params.headers)} };
      const bodyIn = ${JSON.stringify(params.body)};
      if (bodyIn !== null && init.method !== 'GET' && init.method !== 'HEAD') init.body = bodyIn;
      const response = await fetch(${JSON.stringify(params.url)}, init);
      const text = await response.text();
      const maxBytes = ${JSON.stringify(params.maxBytes)};
      const truncated = text.length > maxBytes;
      const outHeaders = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      return { status: response.status, statusText: response.statusText, headers: outHeaders,
        body: truncated ? text.slice(0, maxBytes) : text, bytes: text.length, truncated };
    })()`;
    const value = (await this.runExpression(expression, true)) as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      bytes: number;
      truncated: boolean;
    };
    return value;
  }

  async close(): Promise<void> {
    this.conn.close();
  }

  // --- CDP helpers -----------------------------------------------------------------------------

  private async currentUrl(): Promise<string> {
    const value = await this.runExpression("location.href", false);
    return typeof value === "string" ? value : "";
  }

  private async runExpression(expression: string, awaitPromise: boolean): Promise<unknown> {
    const result = await this.conn.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      this.sessionId,
    );
    if (isRecord(result.exceptionDetails)) {
      const details = result.exceptionDetails;
      const exception = isRecord(details.exception) ? details.exception : null;
      const message =
        (exception !== null && typeof exception.description === "string" && exception.description) ||
        (typeof details.text === "string" && details.text) ||
        "evaluation threw";
      throw new Error(message);
    }
    const value = isRecord(result.result) ? result.result.value : undefined;
    return value;
  }

  private waitForLifecycle(waitUntil: WaitUntil, timeoutMs: number): Promise<void> {
    if (waitUntil === "commit") {
      return Promise.resolve();
    }
    // load and networkidle both wait for the load event; domcontentloaded waits for its own. A true
    // network-idle wait needs request bookkeeping the five operations do not otherwise keep, so it is
    // approximated by the load event rather than claimed and not delivered.
    const method = waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
    const event = this.conn.waitFor(method, this.sessionId);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`navigation did not reach ${waitUntil} within ${timeoutMs} ms`));
      }, timeoutMs);
      event.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}

/**
 * Wire a launched Edge into one page session and a CDP-backed driver: dial the browser endpoint,
 * create one page target, attach to it flattened onto that same connection, and enable the domains
 * the operations need. The session's `closed` settles when Edge exits, so the engine can drop and
 * relaunch it; `close` ends Edge and its throwaway profile.
 */
async function openEdgeSession(process: EdgeProcess, dialer: CdpDialer): Promise<BrowserSession> {
  let conn: CdpConnection | null = null;
  try {
    const url = await process.debuggerUrl();
    conn = await CdpConnection.open(dialer, url);
    const target = await conn.send("Target.createTarget", { url: "about:blank" });
    const targetId = target.targetId;
    if (typeof targetId !== "string") {
      throw new Error("Edge did not return a target id for the new page");
    }
    const attached = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    if (typeof sessionId !== "string") {
      throw new Error("Edge did not return a session id for the page");
    }
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    await conn.send("Network.enable", {}, sessionId);

    const driver = new CdpBrowserDriver(conn, sessionId);
    const connection = conn;
    return {
      driver,
      closed: process.exited.then(() => undefined),
      close: () => {
        connection.close();
        process.kill();
      },
    };
  } catch (error) {
    if (conn !== null) {
      conn.close();
    }
    process.kill();
    throw error;
  }
}

/**
 * The real browser backend: available when Edge is found, and on `open` it launches Edge and returns
 * a driven page session. The launcher and the CDP dialer are seams, so the backend's wiring is
 * exercised in tests against a fake launcher and a fake socket, and against a real Chromium-family
 * browser separately.
 */
export function edgeBackend(launcher: EdgeLauncher, dialer: CdpDialer = new WebSocketCdpDialer()): BrowserBackend {
  return {
    available: () => launcher.locate() !== null,
    open: () => openEdgeSession(launcher.launch(), dialer),
  };
}
