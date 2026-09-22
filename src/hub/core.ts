// The hub's core: it holds every agent connection and routes every frame, with no transport in it.

import { createHash } from "node:crypto";

import {
  CHECKSUM_ALGORITHM,
  PROTOCOL_VERSION,
  TRANSFER_CHUNK_BYTES,
  checksum,
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type EncodedBytes,
  type Frame,
  type FrameType,
  type HelloFrame,
  type ShellKind,
  type TransferDirection,
} from "../protocol";

/**
 * The hub's handle on one agent socket. The server wraps a Bun `ServerWebSocket` in this; a test
 * wraps a fake. `socketId` identifies the physical connection so a frame or a close from a
 * superseded socket can be told from the one now holding its agent's name and ignored.
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

/**
 * One event in a transfer's life, delivered to whichever control caller owns it. A download reports
 * `begin` (the agent's declared size and checksum) then a run of `chunk`; both directions end in a
 * terminal `completed` (verified), `error`, or `ended`.
 */
export type TransferEvent =
  | { kind: "started"; id: string }
  | { kind: "begin"; total: number; checksum: string }
  | { kind: "chunk"; seq: number; chunk: EncodedBytes }
  | { kind: "completed"; total: number; checksum: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "ended"; reason: string };

/**
 * What a control caller supplies to receive a transfer's events. The hub pushes each event and then
 * calls `end` exactly once, after a terminal event. A caller that has gone away makes `push` a no-op.
 */
export interface TransferListener {
  push(event: TransferEvent): void;
  end(): void;
}

/** An upload a control caller starts: the bytes to write and the path to write them to on the machine. */
export interface UploadParams {
  path: string;
  data: Uint8Array;
}

/** A download a control caller starts: the path to read back from the machine. */
export interface DownloadParams {
  path: string;
}

export type StartResult = { ok: true; id: string } | { ok: false; reason: string };
export type CancelResult = { ok: true } | { ok: false; reason: string };

/**
 * Why a request could not be given an agent: none is attached, the one it named is not, or it named
 * none while several are attached and the choice is not the hub's to make.
 */
export type TargetRefusal = "no-agent" | "unknown-agent" | "agent-required";

export type TargetResult = { ok: true; name: string } | { ok: false; code: TargetRefusal; reason: string };

/** The public facts about one attached agent, as the status endpoint reports them. */
export interface AgentStatus {
  name: string;
  agentVersion: string;
  capabilities: string[];
  connectedAt: number;
  lastPongAt: number;
  /** The ids of the commands still streaming on this agent. */
  inFlight: string[];
}

export interface StatusSnapshot {
  /** Identifies this hub process, so a console can tell its traffic cursor is still valid. */
  run: string;
  /** True while at least one agent is attached. */
  attached: boolean;
  /** Every attached agent, ordered by name. */
  agents: AgentStatus[];
}

/**
 * One line of the traffic log: a frame that crossed the tunnel, reduced to its shape. The base64 of
 * a payload is deliberately dropped — the log is a monitoring feed, bounded by count, not a place to
 * hold megabytes of output. The live exec stream carries the real bytes.
 */
export interface TrafficEntry {
  id: number;
  at: number;
  /** The agent the frame crossed to or from; null for a frame from a socket that never said hello. */
  agent: string | null;
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

// One attached agent and everything that lives and dies with its connection: the liveness probe,
// the commands and the transfers streaming over it.
interface AttachedAgent {
  link: AgentLink;
  name: string;
  agentVersion: string;
  capabilities: string[];
  connectedAt: number;
  lastPongAt: number;
  pingTimer: ReturnType<typeof setInterval> | null;
  commands: Map<string, Command>;
  transfers: Map<string, Transfer>;
}

interface Command {
  id: string;
  listener: CommandListener;
}

// One transfer in flight. On an upload the hub is the sender and only waits for the agent's ack; on a
// download the hub is the receiver, so it advances a running hash and byte count as chunks arrive and
// checks them against the agent's declared total and checksum when the transfer closes.
interface Transfer {
  id: string;
  direction: TransferDirection;
  listener: TransferListener;
  expectedSeq: number;
  received: number;
  hash: ReturnType<typeof createHash> | null;
}

export class HubCore {
  private readonly options: Required<HubCoreOptions>;
  /** A random tag for this process, so a console can detect a hub restart and re-sync its cursor. */
  readonly run: string;

  /** Every attached agent by its name, one connection per name. */
  private readonly agents = new Map<string, AttachedAgent>();
  /** The same agents by the socket they hold, so a frame or a close finds its agent. */
  private readonly bySocket = new Map<number, AttachedAgent>();

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
    const known = this.bySocket.get(link.socketId) ?? null;
    const result = decodeFrame(raw, { maxPayloadBytes: this.options.maxPayloadBytes });
    if (!result.ok) {
      this.record(known?.name ?? null, "in", "invalid", { code: result.error.code, message: result.error.message });
      return;
    }

    const frame = result.frame;
    if (frame.type === "hello") {
      this.attach(link, frame);
      return;
    }

    // Only an attached socket may drive the hub. A frame from a socket that never sent a hello, or
    // from one that has since been superseded, is dropped.
    if (known === null) {
      return;
    }

    this.record(known.name, "in", frame.type, this.summaryOf(frame));
    this.route(known, frame);
  }

  /** Note that an agent socket has closed. Only a socket still holding its name detaches an agent. */
  onClose(link: AgentLink): void {
    const agent = this.bySocket.get(link.socketId);
    if (agent !== undefined) {
      this.detach(agent, "agent connection closed", false);
    }
  }

  private attach(link: AgentLink, hello: HelloFrame): void {
    this.record(hello.agent, "in", "hello", this.summaryOf(hello));

    // A socket that already holds another name gives that name up; the socket itself carries on.
    const renamed = this.bySocket.get(link.socketId);
    if (renamed !== undefined && renamed.name !== hello.agent) {
      this.detach(renamed, "the connection said hello under another name", false);
    }

    // One connection per name. Whatever held this name on another socket is displaced and its socket
    // closed with a stated reason, so a redial after a half-dead TCP connection does not leave two
    // peers streaming as the same machine. Agents under other names are left alone.
    const previous = this.agents.get(hello.agent);
    if (previous !== undefined) {
      this.detach(previous, "superseded by a new connection", previous.link.socketId !== link.socketId);
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
      commands: new Map(),
      transfers: new Map(),
    };
    this.agents.set(agent.name, agent);
    this.bySocket.set(link.socketId, agent);
    agent.pingTimer = setInterval(() => this.pingTick(agent), this.options.pingIntervalMs);

    this.send(agent, { type: "welcome", v: PROTOCOL_VERSION, hubVersion: this.options.hubVersion });
  }

  private detach(agent: AttachedAgent, reason: string, closeSocket: boolean): void {
    if (this.agents.get(agent.name) !== agent) {
      return;
    }

    // Forget the agent first, so the close below — which fires onClose for the same socket — finds
    // nothing to detach again.
    this.agents.delete(agent.name);
    this.bySocket.delete(agent.link.socketId);
    if (agent.pingTimer !== null) {
      clearInterval(agent.pingTimer);
    }
    if (closeSocket) {
      agent.link.close(CLOSE_HUB_INITIATED, reason);
    }

    // Nothing in flight can outlive the socket it streamed over: end every command and every transfer
    // this agent carried rather than leave a control caller hanging.
    for (const command of agent.commands.values()) {
      command.listener.push({ kind: "ended", reason });
      command.listener.end();
    }
    agent.commands.clear();
    for (const transfer of agent.transfers.values()) {
      transfer.listener.push({ kind: "ended", reason });
      transfer.listener.end();
    }
    agent.transfers.clear();
  }

  private pingTick(agent: AttachedAgent): void {
    const deadAfterMs = this.options.pingIntervalMs * this.options.missedPongLimit;
    if (Date.now() - agent.lastPongAt > deadAfterMs) {
      this.detach(agent, "no pong within the liveness window", true);
      return;
    }

    this.send(agent, { type: "ping", v: PROTOCOL_VERSION, ts: Date.now() });
  }

  private route(agent: AttachedAgent, frame: Frame): void {
    switch (frame.type) {
      case "pong": {
        agent.lastPongAt = Date.now();
        return;
      }
      case "ping": {
        this.send(agent, { type: "pong", v: PROTOCOL_VERSION, ts: frame.ts });
        return;
      }
      case "stdout": {
        agent.commands.get(frame.id)?.listener.push({ kind: "stdout", seq: frame.seq, chunk: frame.chunk });
        return;
      }
      case "stderr": {
        agent.commands.get(frame.id)?.listener.push({ kind: "stderr", seq: frame.seq, chunk: frame.chunk });
        return;
      }
      case "exit": {
        const command = agent.commands.get(frame.id);
        if (command !== undefined) {
          command.listener.push({ kind: "exit", code: frame.code, signal: frame.signal, canceled: frame.canceled });
          command.listener.end();
          agent.commands.delete(frame.id);
        }
        return;
      }
      case "error": {
        // An error answers a command the agent refused before it could stream (an unknown shell, a
        // spawn failure, say), or a transfer that failed (a missing file, a bad checksum).
        const command = agent.commands.get(frame.id);
        if (command !== undefined) {
          command.listener.push({ kind: "error", code: frame.code, message: frame.message });
          command.listener.end();
          agent.commands.delete(frame.id);
          return;
        }
        const transfer = agent.transfers.get(frame.id);
        if (transfer !== undefined) {
          this.failTransfer(agent, transfer, frame.code, frame.message);
        }
        return;
      }
      case "transfer-begin": {
        // A download's begin from the agent: the size and checksum it is about to stream.
        const transfer = agent.transfers.get(frame.id);
        if (transfer !== undefined && transfer.direction === "download" && frame.total !== null && frame.checksum !== null) {
          transfer.listener.push({ kind: "begin", total: frame.total, checksum: frame.checksum });
        }
        return;
      }
      case "transfer-chunk": {
        const transfer = agent.transfers.get(frame.id);
        if (transfer === undefined || transfer.direction !== "download") {
          return;
        }
        if (frame.seq !== transfer.expectedSeq) {
          this.failTransfer(agent, transfer, "out-of-order", `expected chunk ${transfer.expectedSeq}, got ${frame.seq}`);
          return;
        }
        const decoded = decodeBytes(frame.chunk, { maxPayloadBytes: this.options.maxPayloadBytes });
        if (!decoded.ok) {
          this.failTransfer(agent, transfer, "bad-chunk", decoded.error.message);
          return;
        }
        transfer.expectedSeq += 1;
        transfer.received += decoded.data.byteLength;
        transfer.hash?.update(decoded.data);
        transfer.listener.push({ kind: "chunk", seq: frame.seq, chunk: frame.chunk });
        return;
      }
      case "transfer-end": {
        const transfer = agent.transfers.get(frame.id);
        if (transfer === undefined) {
          return;
        }
        if (transfer.direction === "upload") {
          // The agent's acknowledgement: it verified the bytes and moved the file into place.
          transfer.listener.push({ kind: "completed", total: frame.total, checksum: frame.checksum });
        } else {
          // A download closes: accept it only if what we assembled matches the declared total and checksum.
          const verified = transfer.received === frame.total && transfer.hash !== null && transfer.hash.digest("hex") === frame.checksum;
          if (verified) {
            transfer.listener.push({ kind: "completed", total: frame.total, checksum: frame.checksum });
          } else {
            transfer.listener.push({
              kind: "error",
              code: "integrity",
              message: `assembled ${transfer.received} bytes did not match the declared transfer`,
            });
          }
        }
        transfer.listener.end();
        agent.transfers.delete(frame.id);
        return;
      }
      default:
        // hello/welcome/reject/exec/cancel/leave are hub-outbound or handshake frames; if one
        // arrives from the agent it is not the hub's to act on.
        return;
    }
  }

  // --- Control operations -----------------------------------------------------------------------

  /**
   * Decide which agent a request goes to. A named agent must be attached; no name picks the only
   * agent attached, and is refused while there are several, so a request never lands on a machine
   * nobody chose.
   */
  resolveTarget(name: string | null): TargetResult {
    const found = this.findTarget(name);
    return found.ok ? { ok: true, name: found.agent.name } : found;
  }

  private findTarget(name: string | null): { ok: true; agent: AttachedAgent } | { ok: false; code: TargetRefusal; reason: string } {
    if (this.agents.size === 0) {
      return { ok: false, code: "no-agent", reason: "no agent attached" };
    }
    if (name !== null) {
      const agent = this.agents.get(name);
      return agent === undefined
        ? { ok: false, code: "unknown-agent", reason: `no agent named ${name} is attached` }
        : { ok: true, agent };
    }
    if (this.agents.size > 1) {
      const names = [...this.agents.keys()].sort().join(", ");
      return { ok: false, code: "agent-required", reason: `${this.agents.size} agents are attached (${names}); name one` };
    }
    return { ok: true, agent: this.agents.values().next().value as AttachedAgent };
  }

  /** Start a shell command on the target agent, streaming its life to `listener`. */
  startExec(params: ExecParams, listener: CommandListener, target: string | null = null): StartResult {
    const found = this.findTarget(target);
    if (!found.ok) {
      return { ok: false, reason: found.reason };
    }
    const agent = found.agent;

    const id = this.nextId("c");
    agent.commands.set(id, { id, listener });
    listener.push({ kind: "started", id });
    this.send(agent, {
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

  /**
   * Ask the agent running a command to stop it. The command ends when its exit frame arrives. A
   * command id is unique across the hub, so the id alone finds the agent.
   */
  cancel(id: string): CancelResult {
    if (this.agents.size === 0) {
      return { ok: false, reason: "no agent attached" };
    }
    const agent = [...this.agents.values()].find((candidate) => candidate.commands.has(id));
    if (agent === undefined) {
      return { ok: false, reason: "unknown command" };
    }
    this.send(agent, { type: "cancel", v: PROTOCOL_VERSION, id });
    return { ok: true };
  }

  /**
   * Write a file onto the machine, streaming it as chunk frames the agent assembles and verifies. The
   * hub is the sender: it declares the total and checksum up front, sends the content in fixed chunks
   * held below either side's payload cap, and closes with the same total and checksum. The transfer
   * completes when the agent acknowledges the verified write.
   */
  startUpload(params: UploadParams, listener: TransferListener, target: string | null = null): StartResult {
    const found = this.findTarget(target);
    if (!found.ok) {
      return { ok: false, reason: found.reason };
    }
    const agent = found.agent;

    const id = this.nextId("u");
    const total = params.data.byteLength;
    const sum = checksum(params.data);
    agent.transfers.set(id, { id, direction: "upload", listener, expectedSeq: 0, received: 0, hash: null });
    listener.push({ kind: "started", id });

    this.send(agent, { type: "transfer-begin", v: PROTOCOL_VERSION, id, direction: "upload", path: params.path, total, checksum: sum });
    let seq = 0;
    for (let offset = 0; offset < total; offset += TRANSFER_CHUNK_BYTES) {
      const slice = params.data.subarray(offset, Math.min(offset + TRANSFER_CHUNK_BYTES, total));
      this.send(agent, { type: "transfer-chunk", v: PROTOCOL_VERSION, id, seq: seq++, chunk: encodeBytes(slice) });
    }
    this.send(agent, { type: "transfer-end", v: PROTOCOL_VERSION, id, total, checksum: sum });
    return { ok: true, id };
  }

  /**
   * Read a file back from the machine. The hub is the receiver: it requests the path, the agent
   * answers with the size and checksum it will stream, and the hub advances a running hash over the
   * chunks so it can verify the whole content against that declared total and checksum when the
   * transfer closes.
   */
  startDownload(params: DownloadParams, listener: TransferListener, target: string | null = null): StartResult {
    const found = this.findTarget(target);
    if (!found.ok) {
      return { ok: false, reason: found.reason };
    }
    const agent = found.agent;

    const id = this.nextId("d");
    agent.transfers.set(id, { id, direction: "download", listener, expectedSeq: 0, received: 0, hash: createHash(CHECKSUM_ALGORITHM) });
    listener.push({ kind: "started", id });
    this.send(agent, { type: "transfer-begin", v: PROTOCOL_VERSION, id, direction: "download", path: params.path, total: null, checksum: null });
    return { ok: true, id };
  }

  private failTransfer(agent: AttachedAgent, transfer: Transfer, code: string, message: string): void {
    transfer.listener.push({ kind: "error", code, message });
    transfer.listener.end();
    agent.transfers.delete(transfer.id);
  }

  /**
   * Tell the target agent to erase itself and depart. The hub only relays the signal; the agent does
   * the erasing and then drops its connection, which is the hub's confirmation it went. There is
   * nothing to wait for, so this returns as soon as the frame is on its way.
   */
  leave(target: string | null = null): CancelResult {
    const found = this.findTarget(target);
    if (!found.ok) {
      return { ok: false, reason: found.reason };
    }
    this.send(found.agent, { type: "leave", v: PROTOCOL_VERSION });
    return { ok: true };
  }

  status(): StatusSnapshot {
    const agents = [...this.agents.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({
        name: agent.name,
        agentVersion: agent.agentVersion,
        capabilities: [...agent.capabilities],
        connectedAt: agent.connectedAt,
        lastPongAt: agent.lastPongAt,
        inFlight: [...agent.commands.keys()],
      }));
    return { run: this.run, attached: agents.length > 0, agents };
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

  /** Stop probing, close every agent socket, and end every command in flight. For shutdown. */
  shutdown(): void {
    for (const agent of [...this.agents.values()]) {
      this.detach(agent, "hub shutting down", true);
    }
    this.tailSubs.clear();
  }

  // --- Internals --------------------------------------------------------------------------------

  private send(agent: AttachedAgent, frame: Frame): void {
    agent.link.send(encodeFrame(frame));
    this.record(agent.name, "out", frame.type, this.summaryOf(frame));
  }

  private record(agent: string | null, dir: "in" | "out", type: FrameType | "invalid", summary: Record<string, unknown>): void {
    const entry: TrafficEntry = { id: ++this.trafficSeq, at: Date.now(), agent, dir, type, summary };
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
      case "leave":
        return {};
      case "error":
        return { id: frame.id, code: frame.code, message: frame.message };
      case "transfer-begin":
        return { id: frame.id, direction: frame.direction, path: frame.path, total: frame.total };
      case "transfer-chunk":
        return { id: frame.id, seq: frame.seq, bytes: frame.chunk.bytes };
      case "transfer-end":
        return { id: frame.id, total: frame.total };
      case "ping":
      case "pong":
        return { ts: frame.ts };
    }
  }
}
