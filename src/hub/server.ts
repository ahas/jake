// The two servers that give the hub core a wire: one faces the agent, one the console.

import type { Server, ServerWebSocket } from "bun";

import type { HubConfig } from "../config";
import { isShellKind, SHELL_KINDS } from "../protocol";
import {
  HubCore,
  type AgentLink,
  type CommandListener,
  type ExecEvent,
  type ExecParams,
  type HubCoreOptions,
  type SendOutcome,
  type StartResult,
  type TargetRefusal,
  type TransferEvent,
  type TransferListener,
} from "./core";
import { renderConsolePage } from "./page";

/**
 * Per-socket state the agent server hangs on each upgraded connection: its id, and whoever is waiting
 * for its backlog to drain.
 */
interface SocketData {
  socketId: number;
  drainWaiters: Array<() => void>;
}

// A stream sends nothing between events, so the connection's idle limit must outlast one keep-alive.
const PING_COMMENT_MS = 15_000;
const IDLE_TIMEOUT_S = 240;

/** What `startHub` hands back: the running servers, their bound ports, and a clean shutdown. */
export interface RunningHub {
  core: HubCore;
  agentServer: Server<SocketData>;
  controlServer: Server<undefined>;
  agentPort: number;
  controlPort: number;
  close(): void;
}

/** Options a caller (chiefly a test) layers over the config: shorter timers, an ephemeral port. */
export interface StartHubOptions {
  /** Override the agent-server port. 0 binds an ephemeral port; useful in tests. */
  agentPort?: number;
  /** Override the control-server port. 0 binds an ephemeral port; useful in tests. */
  controlPort?: number;
  /** Core knobs — ping interval, missed-pong limit, ring size. */
  core?: Pick<HubCoreOptions, "pingIntervalMs" | "missedPongLimit" | "ringSize">;
  /** Where the hub writes its one-line notices, such as a refused agent. Defaults to stderr. */
  log?: (line: string) => void;
  /**
   * How many bytes an agent socket may hold queued before it discards further frames. Defaults to
   * Bun's own limit; a test sets it small to reach the limit with a small file.
   */
  socketBacklogBytes?: number;
}

/**
 * Where an agent's upgrade came from: the address the proxy in front of the hub forwarded, else the
 * socket's own peer.
 */
function peerOf(request: Request, server: Server<SocketData>): string {
  const forwarded = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || server.requestIP(request)?.address || "unknown";
}

// Bun answers a send with the bytes written, -1 when it queued the frame behind a backlog, or 0 when
// it discarded the frame.
function sendOutcomeOf(status: number): SendOutcome {
  if (status > 0) return "sent";
  return status === -1 ? "queued" : "dropped";
}

/** Wake everyone waiting on this socket's backlog, when it drains or when the socket closes. */
function releaseDrainWaiters(ws: ServerWebSocket<SocketData>): void {
  const waiters = ws.data.drainWaiters.splice(0);
  for (const wake of waiters) {
    wake();
  }
}

function linkOf(ws: ServerWebSocket<SocketData>): AgentLink {
  return {
    socketId: ws.data.socketId,
    send: (text) => sendOutcomeOf(ws.send(text)),
    drained: () =>
      new Promise<void>((resolve) => {
        if (ws.readyState !== WebSocket.OPEN || ws.getBufferedAmount() === 0) {
          resolve();
          return;
        }
        ws.data.drainWaiters.push(resolve);
      }),
    close: (code, reason) => {
      ws.close(code, reason);
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseHeaders(): HeadersInit {
  return { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };
}

function sseFrame(event: string, data: unknown, id?: number): string {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function execEventFrame(event: ExecEvent): string {
  const { kind, ...rest } = event;
  return sseFrame(kind, rest);
}

function transferEventFrame(event: TransferEvent): string {
  const { kind, ...rest } = event;
  return sseFrame(kind, rest);
}

function parseExecBody(body: unknown): ExecParams | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be an object" };
  }
  const b = body as Record<string, unknown>;
  const shell = b.shell;
  if (!isShellKind(shell)) {
    return { error: `shell must be one of ${SHELL_KINDS.join(", ")}` };
  }
  if (typeof b.command !== "string") {
    return { error: "command must be a string" };
  }
  const cwd = b.cwd === undefined || b.cwd === null ? null : b.cwd;
  if (cwd !== null && typeof cwd !== "string") {
    return { error: "cwd must be a string or null" };
  }
  const env: Record<string, string> = {};
  if (b.env !== undefined && b.env !== null) {
    if (typeof b.env !== "object" || Array.isArray(b.env)) {
      return { error: "env must be a string map" };
    }
    for (const [key, value] of Object.entries(b.env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { error: `env.${key} must be a string` };
      }
      env[key] = value;
    }
  }
  const distro = b.distro === undefined || b.distro === null ? null : b.distro;
  if (distro !== null && typeof distro !== "string") {
    return { error: "distro must be a string or null" };
  }
  return { shell, command: b.command, cwd, env, distro };
}

// --- The SSE streams: exec and transfer ----------------------------------------------------------

/**
 * Build an SSE response driven by `begin`, which wires the stream's events to `write` and closes it
 * with `finish`; if `begin` declines (no agent), the stream states the reason and ends. A keep-alive
 * comment holds the control connection open through a stretch with no real events — a long command,
 * or a large transfer between chunks — past its idle limit.
 */
function sseStream(begin: (write: (chunk: string) => void, finish: () => void) => StartResult): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (keepAlive !== null) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        try {
          controller.close();
        } catch {
          // The reader had already left.
        }
      };

      const started = begin(write, finish);
      if (!started.ok) {
        write(sseFrame("ended", { reason: started.reason }));
        finish();
        return;
      }

      keepAlive = setInterval(() => write(": ping\n\n"), PING_COMMENT_MS);
    },
    cancel() {
      if (keepAlive !== null) {
        clearInterval(keepAlive);
        keepAlive = null;
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function execStream(core: HubCore, params: ExecParams, target: string): Response {
  return sseStream((write, finish) => {
    const listener: CommandListener = { push: (event) => write(execEventFrame(event)), end: finish };
    return core.startExec(params, listener, target);
  });
}

function uploadStream(core: HubCore, path: string, data: Uint8Array, target: string): Response {
  return sseStream((write, finish) => {
    const listener: TransferListener = { push: (event) => write(transferEventFrame(event)), end: finish };
    return core.startUpload({ path, data }, listener, target);
  });
}

function downloadStream(core: HubCore, path: string, target: string): Response {
  return sseStream((write, finish) => {
    const listener: TransferListener = { push: (event) => write(transferEventFrame(event)), end: finish };
    return core.startDownload({ path }, listener, target);
  });
}

// The HTTP status each target refusal answers with: nothing attached is a conflict with the hub's
// state, a name that is not attached is not found, and a missing name is the caller's to supply.
const TARGET_REFUSAL_STATUS: Record<TargetRefusal, number> = {
  "no-agent": 409,
  "unknown-agent": 404,
  "agent-required": 400,
};

/** The agent a request names in its `agent` query parameter, or null when it names none. */
function requestedAgent(url: URL): string | null {
  const name = url.searchParams.get("agent");
  return name === null || name === "" ? null : name;
}

// --- The traffic tail SSE stream -----------------------------------------------------------------

function tailStream(core: HubCore, afterId: number): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    if (ping !== null) {
      clearInterval(ping);
      ping = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };

      // The run tag first, so a late console can tell whether its cursor still counts against this
      // process; then the replay it missed; then the live feed, taken up in the same breath.
      write(sseFrame("run", { run: core.run }));
      for (const entry of core.trafficSince(afterId)) {
        write(sseFrame("traffic", entry, entry.id));
      }
      unsubscribe = core.subscribeTraffic((entry) => write(sseFrame("traffic", entry, entry.id)));
      ping = setInterval(() => write(": ping\n\n"), PING_COMMENT_MS);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

// --- Control routing -----------------------------------------------------------------------------

async function route(core: HubCore, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/status") {
    return json(core.status());
  }

  if (method === "GET" && path === "/events") {
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
    return tailStream(core, Number.isNaN(after) ? 0 : after);
  }

  if (method === "POST" && path === "/exec") {
    const body = await request.json().catch(() => null);
    const params = parseExecBody(body);
    if ("error" in params) {
      return json({ error: params.error }, 400);
    }
    const target = core.resolveTarget(requestedAgent(url));
    if (!target.ok) {
      return json({ error: target.reason, code: target.code }, TARGET_REFUSAL_STATUS[target.code]);
    }
    return execStream(core, params, target.name);
  }

  if (method === "POST" && (path === "/upload" || path === "/download")) {
    const remote = url.searchParams.get("path");
    if (remote === null || remote === "") {
      return json({ error: "the path query parameter is required" }, 400);
    }
    const target = core.resolveTarget(requestedAgent(url));
    if (!target.ok) {
      return json({ error: target.reason, code: target.code }, TARGET_REFUSAL_STATUS[target.code]);
    }
    if (path === "/upload") {
      const data = new Uint8Array(await request.arrayBuffer());
      return uploadStream(core, remote, data, target.name);
    }
    return downloadStream(core, remote, target.name);
  }

  if (method === "POST" && path === "/cancel") {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    if (body === null || typeof body.id !== "string") {
      return json({ error: "id must be a string" }, 400);
    }
    const result = core.cancel(body.id);
    return result.ok ? json({ ok: true }) : json({ ok: false, reason: result.reason }, 409);
  }

  if (method === "POST" && path === "/leave") {
    const target = core.resolveTarget(requestedAgent(url));
    if (!target.ok) {
      return json({ ok: false, reason: target.reason, code: target.code }, TARGET_REFUSAL_STATUS[target.code]);
    }
    const result = core.leave(target.name);
    return result.ok ? json({ ok: true, agent: target.name }) : json({ ok: false, reason: result.reason }, 409);
  }

  return json({ error: "not found" }, 404);
}

// --- Start ---------------------------------------------------------------------------------------

/**
 * Start both servers. The agent server binds to the configured host so the agent can reach it
 * through NPM; the control server binds to loopback alone. Ports and short timers may be overridden
 * for a test.
 */
export function startHub(config: HubConfig, options: StartHubOptions = {}): RunningHub {
  const core = new HubCore({
    secret: config.secret,
    controlToken: config.controlToken,
    maxPayloadBytes: config.maxPayloadBytes,
    hubVersion: "0.1.0",
    ...options.core,
  });
  const log = options.log ?? ((line: string) => console.warn(line));

  const agentServer = Bun.serve<SocketData>({
    hostname: config.host,
    port: options.agentPort ?? config.port,
    fetch(request, server) {
      const credential = request.headers.get("authorization");
      if (!core.authorizeAgent(credential)) {
        // Only an upgrade is an agent's attempt; a plain request — the agent's own follow-up probe,
        // or a passer-by — is answered the same and left out. The line says whether a credential
        // came at all, and never what it was.
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const what = credential === null ? "no credential" : "a wrong credential";
          log(`jake hub: refused an agent connection from ${peerOf(request, server)} (${what})`);
        }
        return json({ error: "unauthorized" }, 401);
      }
      if (server.upgrade(request, { data: { socketId: core.nextSocketId(), drainWaiters: [] } })) {
        return undefined;
      }
      return json({ error: "expected a WebSocket upgrade" }, 426);
    },
    websocket: {
      ...(options.socketBacklogBytes === undefined ? {} : { backpressureLimit: options.socketBacklogBytes }),
      message(ws, message) {
        core.onMessage(linkOf(ws), typeof message === "string" ? message : message.toString());
      },
      drain(ws) {
        // A frame sent from inside this callback that meets a backlog again is never followed by
        // another drain, so the waiters resume on the next turn of the loop, outside it.
        setImmediate(() => releaseDrainWaiters(ws));
      },
      close(ws) {
        releaseDrainWaiters(ws);
        core.onClose(linkOf(ws));
      },
    },
  });

  const controlServer = Bun.serve({
    hostname: "127.0.0.1",
    port: options.controlPort ?? config.controlPort,
    idleTimeout: IDLE_TIMEOUT_S,
    async fetch(request) {
      // The read-only status page is the one unauthenticated route: a browser navigation cannot
      // carry a bearer header, so the page is served open — safe on a loopback-only server — and it
      // embeds the token to make its own read requests.
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(renderConsolePage(config.controlToken), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (!core.authorizeControl(request.headers.get("authorization"))) {
        return json({ error: "unauthorized" }, 401);
      }
      try {
        return await route(core, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  });

  return {
    core,
    agentServer,
    controlServer,
    agentPort: agentServer.port ?? 0,
    controlPort: controlServer.port ?? 0,
    close() {
      core.shutdown();
      agentServer.stop(true);
      controlServer.stop(true);
    },
  };
}
