// Runs the agent as its own process against a stand-in hub the test drives frame by frame.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MANIFEST = join(ROOT, "agent", "Cargo.toml");

/** The agent under contract: started as a process, so the tests hold whatever it is written in. */
export const AGENT_COMMAND: readonly string[] = [join(ROOT, "target", "debug", "jake")];

let built = false;

/** Build the agent once per test run; cargo answers at once when nothing changed. */
export function ensureAgentBuilt(): void {
  if (built) return;
  const result = Bun.spawnSync(["cargo", "build", "--offline", "--quiet", "--manifest-path", MANIFEST], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("cargo build of the agent failed");
  built = true;
}

/** One frame as the wire carries it, read loosely: the tests check fields by name. */
export type WireFrame = { type: string; v: number } & Record<string, unknown>;

/** Wait until a condition holds, polling it; fails with the label once the bound runs out. */
export async function until(label: string, pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** One socket the agent opened to the stand-in hub. */
export class HubConnection {
  readonly frames: WireFrame[] = [];
  closed = false;
  private consumed = 0;

  constructor(private readonly socket: { send(text: string): unknown; close(code?: number, reason?: string): void }) {}

  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ v: 1, ...frame }));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  close(): void {
    this.socket.close(1000, "closed by the test");
  }

  /** The first frame, after those already taken, that matches; it and everything before it are taken. */
  async next(pred: (frame: WireFrame) => boolean, label = "a frame", timeoutMs = 5_000): Promise<WireFrame> {
    let found: WireFrame | undefined;
    await until(label, () => {
      const index = this.frames.findIndex((frame, at) => at >= this.consumed && pred(frame));
      if (index === -1) return false;
      found = this.frames[index];
      this.consumed = index + 1;
      return true;
    }, timeoutMs);
    return found as WireFrame;
  }

  /** Every frame received so far that matches, taken or not. */
  all(pred: (frame: WireFrame) => boolean): WireFrame[] {
    return this.frames.filter(pred);
  }
}

/** A stand-in hub: it checks the Bearer secret at the upgrade and hands each socket to the test. */
export class StandInHub {
  readonly connections: HubConnection[] = [];
  private readonly server: ReturnType<typeof Bun.serve<{ connection: HubConnection | null }, never>>;

  /** A hub over TLS when given a certificate and key, PEM-encoded; plain otherwise. */
  constructor(secret: string, private readonly tls?: { cert: string; key: string }) {
    this.server = Bun.serve<{ connection: HubConnection | null }, never>({
      hostname: "127.0.0.1",
      port: 0,
      ...(tls === undefined ? {} : { tls }),
      fetch: (request, server) => {
        if (request.headers.get("authorization") !== `Bearer ${secret}`) {
          return new Response("unauthorized", { status: 401 });
        }
        if (server.upgrade(request, { data: { connection: null } })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 426 });
      },
      websocket: {
        maxPayloadLength: 64 * 1024 * 1024,
        open: (ws) => {
          const connection = new HubConnection(ws);
          ws.data.connection = connection;
          this.connections.push(connection);
        },
        message: (ws, message) => {
          ws.data.connection?.frames.push(JSON.parse(String(message)) as WireFrame);
        },
        close: (ws) => {
          if (ws.data.connection !== null) ws.data.connection.closed = true;
        },
      },
    });
  }

  get url(): string {
    return `${this.tls === undefined ? "ws" : "wss"}://127.0.0.1:${this.server.port}`;
  }

  /** The connection at `index`, in the order the agent opened them, once its hello has arrived. */
  async connection(index: number): Promise<HubConnection> {
    await until(`connection ${index}`, () => this.connections.length > index);
    const connection = this.connections[index] as HubConnection;
    await until("the hello", () => connection.frames.some((frame) => frame.type === "hello"));
    return connection;
  }

  /** The connection at `index`, welcomed. */
  async welcomed(index: number): Promise<HubConnection> {
    const connection = await this.connection(index);
    connection.send({ type: "welcome", hubVersion: "test" });
    return connection;
  }

  stop(): void {
    this.server.stop(true);
  }
}

/** What an agent process is started with beyond the hub it dials. */
export interface AgentOptions {
  hubUrl: string;
  secret: string;
  name: string;
  /** The home the agent keeps its data under; its log is read from there. */
  home: string;
  /** Further environment, a tuning key or a PATH with stand-in commands on it. */
  env?: Record<string, string>;
}

/** A running agent process: its log, how it ended, and its teardown. */
export interface AgentProcess {
  readonly exited: Promise<number>;
  readonly stderr: () => string;
  /** The events the agent's rolling log holds so far. */
  log(): Array<{ event: string } & Record<string, unknown>>;
  stop(): Promise<void>;
}

/** The agent's rolling log under a home directory. */
export function agentLogPath(home: string): string {
  return join(home, ".local", "share", "jake", "agent.log");
}

/** Start the agent with the given configuration in its environment. */
export function startAgentProcess(options: AgentOptions): AgentProcess {
  ensureAgentBuilt();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: options.home,
    JAKE_HUB_URL: options.hubUrl,
    JAKE_SECRET: options.secret,
    JAKE_AGENT_NAME: options.name,
    ...options.env,
  };
  const child = Bun.spawn([...AGENT_COMMAND], { cwd: options.home, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const piece of child.stderr) stderr += decoder.decode(piece, { stream: true });
  })();
  const logPath = agentLogPath(options.home);
  return {
    exited: child.exited,
    stderr: () => stderr,
    log() {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { event: string } & Record<string, unknown>);
    },
    async stop() {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await child.exited;
      clearTimeout(timer);
    },
  };
}
