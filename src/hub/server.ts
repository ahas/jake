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
} from "./core";
import { renderConsolePage } from "./page";

/** Per-socket state the agent server hangs on each upgraded connection. */
interface SocketData {
  socketId: number;
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
}

function linkOf(ws: ServerWebSocket<SocketData>): AgentLink {
  return {
    socketId: ws.data.socketId,
    send: (text) => {
      ws.send(text);
    },
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

// --- The exec SSE stream -------------------------------------------------------------------------

function execStream(core: HubCore, params: ExecParams): Response {
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

      const listener: CommandListener = {
        push: (event) => write(execEventFrame(event)),
        end: finish,
      };

      const started = core.startExec(params, listener);
      if (!started.ok) {
        write(sseFrame("ended", { reason: started.reason }));
        finish();
        return;
      }

      // A command may run for a long stretch with no output; a keep-alive holds the control
      // connection open past its idle limit until real events resume.
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
    if (!core.status().attached) {
      return json({ error: "no agent attached" }, 409);
    }
    return execStream(core, params);
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
    const result = core.leave();
    return result.ok ? json({ ok: true }) : json({ ok: false, reason: result.reason }, 409);
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

  const agentServer = Bun.serve<SocketData>({
    hostname: config.host,
    port: options.agentPort ?? config.port,
    fetch(request, server) {
      if (!core.authorizeAgent(request.headers.get("authorization"))) {
        return json({ error: "unauthorized" }, 401);
      }
      if (server.upgrade(request, { data: { socketId: core.nextSocketId() } })) {
        return undefined;
      }
      return json({ error: "expected a WebSocket upgrade" }, 426);
    },
    websocket: {
      message(ws, message) {
        core.onMessage(linkOf(ws), typeof message === "string" ? message : message.toString());
      },
      close(ws) {
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
