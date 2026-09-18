// The hub's heart, with no transport in it. It holds the single agent connection, routes every
// frame that crosses the tunnel, tracks the commands in flight, probes the agent for
// liveness, and keeps a bounded log of recent traffic so a console attaching late sees what just
// happened. The Bun servers in server.ts feed it raw frames and expose its operations; this module
// never touches a socket except through the small AgentLink it is handed. docs/architecture.md is
// the canonical statement of the hub's role.

import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type EncodedBytes,
  type Frame,
  type FrameType,
  type HelloFrame,
  type ShellKind,
} from "../protocol";

/**
 * The hub's handle on one agent socket. The server wraps a Bun `ServerWebSocket` in this; a test
 * wraps a fake. `socketId` identifies the physical connection so a frame or a close from a
 * superseded socket can be told from the current one and ignored.
 */
export interface AgentLink {
  readonly socketId: number;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** One event in a command's life, delivered to whichever control caller owns the command. */
export type ExecEvent =
  | { kind: "started"; id: string }
  | { kind: "stdout"; seq: number; chunk: EncodedBytes }
  | { kind: "stderr"; seq: number; chunk: EncodedBytes }
  | { kind: "exit"; code: number | null; signal: string | null; canceled: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "ended"; reason: string };

/**
 * What a control caller supplies to receive a command's events. The hub pushes each event and then
 * calls `end` exactly once, after a terminal event (`exit`, `error`, or `ended`). A caller that has
 * gone away makes `push` a no-op rather than a throw.
 */
export interface CommandListener {
  push(event: ExecEvent): void;
  end(): void;
}

/** The shell-command request a control caller starts. */
export interface ExecParams {
  shell: ShellKind;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  distro: string | null;
}

export type StartResult = { ok: true; id: string } | { ok: false; reason: string };
export type CancelResult = { ok: true } | { ok: false; reason: string };

/** The public facts about the attached agent, as the status endpoint reports them. */
export interface AgentStatus {
  name: string;
  agentVersion: string;
  capabilities: string[];
  connectedAt: number;
  lastPongAt: number;
}

export interface StatusSnapshot {
  /** Identifies this hub process, so a console can tell its traffic cursor is still valid. */
  run: string;
  attached: boolean;
  agent: AgentStatus | null;
  /** The ids of the commands still streaming. */
  inFlight: string[];
}

/**
 * One line of the traffic log: a frame that crossed the tunnel, reduced to its shape. The base64 of
 * a payload is deliberately dropped — the log is a monitoring feed, bounded by count, not a place to
 * hold megabytes of output. The live exec stream carries the real bytes.
 */
export interface TrafficEntry {
  id: number;
  at: number;
  dir: "in" | "out";
  type: FrameType | "invalid";
  summary: Record<string, unknown>;
}

export interface HubCoreOptions {
  /** The shared secret an agent presents as a Bearer credential at the upgrade. */
  secret: string;
  /** The token a control-API caller presents as a Bearer credential. Distinct from the secret. */
  controlToken: string;
  /** The largest declared frame payload the hub will accept from the agent. */
  maxPayloadBytes: number;
  /** The version the hub reports to the agent in its welcome. */
  hubVersion: string;
  /** How often the hub sends a ping to the agent. */
  pingIntervalMs?: number;
  /** How many ping intervals may pass without a pong before the agent is declared dead. */
  missedPongLimit?: number;
  /** How many recent traffic entries to keep for replay. */
  ringSize?: number;
}

const DEFAULT_PING_INTERVAL_MS = 15_000;
const DEFAULT_MISSED_PONG_LIMIT = 3;
const DEFAULT_RING_SIZE = 200;

// The close code the hub uses when it drops an agent on purpose. 4000–4999 is the range reserved
// for application use, so it does not collide with a protocol-level close.
const CLOSE_HUB_INITIATED = 4000;

interface AttachedAgent {
  link: AgentLink;
  name: string;
  agentVersion: string;
  capabilities: string[];
  connectedAt: number;
  lastPongAt: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

interface Command {
  id: string;
  listener: CommandListener;
}

export class HubCore {
  private readonly options: Required<HubCoreOptions>;
  /** A random tag for this process, so a console can detect a hub restart and re-sync its cursor. */
  readonly run: string;

  private current: AttachedAgent | null = null;
  private readonly commands = new Map<string, Command>();

  private readonly traffic: TrafficEntry[] = [];
  private trafficSeq = 0;
  private readonly tailSubs = new Set<(entry: TrafficEntry) => void>();

  private socketSeq = 0;
  private idSeq = 0;

  constructor(options: HubCoreOptions) {
    this.options = {
      pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
      missedPongLimit: DEFAULT_MISSED_PONG_LIMIT,
      ringSize: DEFAULT_RING_SIZE,
      ...options,
    };
    this.run = `hub-${Math.random().toString(36).slice(2, 10)}`;
  }

  // --- Authentication ---------------------------------------------------------------------------

  /** True when the header presents the agent secret. Checked at the upgrade, before a socket opens. */
  authorizeAgent(authHeader: string | null): boolean {
    return authHeader === `Bearer ${this.options.secret}`;
  }

  /** True when the header presents the control token. Checked on every control-API request. */
  authorizeControl(authHeader: string | null): boolean {
    return authHeader === `Bearer ${this.options.controlToken}`;
  }

  /** Hand out the next socket id for a freshly-upgraded agent connection. */
  nextSocketId(): number {
    return ++this.socketSeq;
  }

  // --- Agent socket lifecycle -------------------------------------------------------------------

  /** Feed one raw text frame received from an agent socket. */
  onMessage(link: AgentLink, raw: string): void {
    const result = decodeFrame(raw, { maxPayloadBytes: this.options.maxPayloadBytes });
    if (!result.ok) {
      this.record("in", "invalid", { code: result.error.code, message: result.error.message });
      return;
    }

    const frame = result.frame;
    if (frame.type === "hello") {
      this.attach(link, frame);
      return;
    }

    // Only the current, attached socket may drive the hub. A frame from a socket that never sent a
    // hello, or from one that has since been superseded, is dropped.
    if (this.current === null || this.current.link.socketId !== link.socketId) {
      return;
    }

    this.record("in", frame.type, this.summaryOf(frame));
    this.route(frame);
  }

  /** Note that an agent socket has closed. Only the current socket's close detaches the agent. */
  onClose(link: AgentLink): void {
    if (this.current !== null && this.current.link.socketId === link.socketId) {
      this.detach("agent connection closed", false);
    }
  }

  private attach(link: AgentLink, hello: HelloFrame): void {
    this.record("in", "hello", this.summaryOf(hello));

    // Exactly one agent slot. Whatever occupies it is displaced and its socket closed with a stated
    // reason, so a reconnect after a half-dead TCP connection does not leave two peers streaming.
    if (this.current !== null) {
      this.detach("superseded by a new connection", true);
    }

    const now = Date.now();
    const agent: AttachedAgent = {
      link,
      name: hello.agent,
      agentVersion: hello.agentVersion,
      capabilities: [...hello.capabilities],
      connectedAt: now,
      lastPongAt: now,
      pingTimer: null,
    };
    this.current = agent;
    agent.pingTimer = setInterval(() => this.pingTick(), this.options.pingIntervalMs);

    this.send(link, { type: "welcome", v: PROTOCOL_VERSION, hubVersion: this.options.hubVersion });
  }

  private detach(reason: string, closeSocket: boolean): void {
    const agent = this.current;
    if (agent === null) {
      return;
    }

    // Clear current first, so the close below — which fires onClose for the same socket — sees no
    // current agent to detach again.
    this.current = null;
    if (agent.pingTimer !== null) {
      clearInterval(agent.pingTimer);
    }
    if (closeSocket) {
      agent.link.close(CLOSE_HUB_INITIATED, reason);
    }

    // Nothing in flight can outlive the socket it streamed over: end every command rather than leave
    // a control caller hanging.
    for (const command of this.commands.values()) {
      command.listener.push({ kind: "ended", reason });
      command.listener.end();
    }
    this.commands.clear();
  }

  private pingTick(): void {
    const agent = this.current;
    if (agent === null) {
      return;
    }

    const deadAfterMs = this.options.pingIntervalMs * this.options.missedPongLimit;
    if (Date.now() - agent.lastPongAt > deadAfterMs) {
      this.detach("no pong within the liveness window", true);
      return;
    }

    this.toAgent({ type: "ping", v: PROTOCOL_VERSION, ts: Date.now() });
  }

  private route(frame: Frame): void {
    switch (frame.type) {
      case "pong": {
        if (this.current !== null) {
          this.current.lastPongAt = Date.now();
        }
        return;
      }
      case "ping": {
        this.toAgent({ type: "pong", v: PROTOCOL_VERSION, ts: frame.ts });
        return;
      }
      case "stdout": {
        this.commands.get(frame.id)?.listener.push({ kind: "stdout", seq: frame.seq, chunk: frame.chunk });
        return;
      }
      case "stderr": {
        this.commands.get(frame.id)?.listener.push({ kind: "stderr", seq: frame.seq, chunk: frame.chunk });
        return;
      }
      case "exit": {
        const command = this.commands.get(frame.id);
        if (command !== undefined) {
          command.listener.push({ kind: "exit", code: frame.code, signal: frame.signal, canceled: frame.canceled });
          command.listener.end();
          this.commands.delete(frame.id);
        }
        return;
      }
      case "error": {
        // An error answers a command the agent refused before it could stream (an unknown shell, a
        // spawn failure, say).
        const command = this.commands.get(frame.id);
        if (command !== undefined) {
          command.listener.push({ kind: "error", code: frame.code, message: frame.message });
          command.listener.end();
          this.commands.delete(frame.id);
        }
        return;
      }
      default:
        // hello/welcome/reject/exec/cancel are hub-outbound or handshake frames; if one arrives
        // from the agent it is not the hub's to act on.
        return;
    }
  }

  // --- Control operations -----------------------------------------------------------------------

  /** Start a shell command on the agent, streaming its life to `listener`. */
  startExec(params: ExecParams, listener: CommandListener): StartResult {
    if (this.current === null) {
      return { ok: false, reason: "no agent attached" };
    }

    const id = this.nextId("c");
    this.commands.set(id, { id, listener });
    listener.push({ kind: "started", id });
    this.toAgent({
      type: "exec",
      v: PROTOCOL_VERSION,
      id,
      shell: params.shell,
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      distro: params.distro,
    });
    return { ok: true, id };
  }

  /** Ask the agent to stop a running command. The command ends when its exit frame arrives. */
  cancel(id: string): CancelResult {
    if (this.current === null) {
      return { ok: false, reason: "no agent attached" };
    }
    if (!this.commands.has(id)) {
      return { ok: false, reason: "unknown command" };
    }
    this.toAgent({ type: "cancel", v: PROTOCOL_VERSION, id });
    return { ok: true };
  }

  status(): StatusSnapshot {
    const agent = this.current;
    return {
      run: this.run,
      attached: agent !== null,
      agent:
        agent === null
          ? null
          : {
              name: agent.name,
              agentVersion: agent.agentVersion,
              capabilities: [...agent.capabilities],
              connectedAt: agent.connectedAt,
              lastPongAt: agent.lastPongAt,
            },
      inFlight: [...this.commands.keys()],
    };
  }

  // --- Traffic log ------------------------------------------------------------------------------

  /** The traffic entries recorded after `afterId`, in order — the replay a late console catches up on. */
  trafficSince(afterId: number): TrafficEntry[] {
    return this.traffic.filter((entry) => entry.id > afterId);
  }

  /** Follow the live traffic feed. Returns an unsubscribe function. */
  subscribeTraffic(onEntry: (entry: TrafficEntry) => void): () => void {
    this.tailSubs.add(onEntry);
    return () => {
      this.tailSubs.delete(onEntry);
    };
  }

  /** Stop probing, close the agent socket, and end every command in flight. For shutdown. */
  shutdown(): void {
    this.detach("hub shutting down", true);
    this.tailSubs.clear();
  }

  // --- Internals --------------------------------------------------------------------------------

  private toAgent(frame: Frame): void {
    if (this.current !== null) {
      this.send(this.current.link, frame);
    }
  }

  private send(link: AgentLink, frame: Frame): void {
    link.send(encodeFrame(frame));
    this.record("out", frame.type, this.summaryOf(frame));
  }

  private record(dir: "in" | "out", type: FrameType | "invalid", summary: Record<string, unknown>): void {
    const entry: TrafficEntry = { id: ++this.trafficSeq, at: Date.now(), dir, type, summary };
    this.traffic.push(entry);
    if (this.traffic.length > this.options.ringSize) {
      this.traffic.shift();
    }
    for (const sub of this.tailSubs) {
      sub(entry);
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.idSeq}`;
  }

  private summaryOf(frame: Frame): Record<string, unknown> {
    switch (frame.type) {
      case "hello":
        return { agent: frame.agent, agentVersion: frame.agentVersion, capabilities: frame.capabilities };
      case "welcome":
        return { hubVersion: frame.hubVersion };
      case "reject":
        return { reason: frame.reason };
      case "exec":
        return { id: frame.id, shell: frame.shell, command: frame.command };
      case "stdout":
      case "stderr":
        return { id: frame.id, seq: frame.seq, bytes: frame.chunk.bytes };
      case "exit":
        return { id: frame.id, code: frame.code, signal: frame.signal, canceled: frame.canceled };
      case "cancel":
        return { id: frame.id };
      case "error":
        return { id: frame.id, code: frame.code, message: frame.message };
      case "ping":
      case "pong":
        return { ts: frame.ts };
    }
  }
}
