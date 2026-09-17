// One connection to the hub, from the agent's side, with no dialing or reconnecting in it. It sends
// the hello, dispatches every inbound frame to the handler its type belongs to, streams command and
// call results back, keeps the connection alive with a heartbeat, and — the property that matters
// most when a socket drops — abandons everything in flight rather than leaving a run or a call
// hanging on a socket that is gone. The transport and the clock are injected, so all of this is
// driven on Linux by a fake. The reconnect loop that feeds it one transport after another is in
// runtime.ts; docs/architecture.md is the canonical statement of the agent's shape.

import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type CallFrame,
  type CancelFrame,
  type ExecFrame,
  type ErrorFrame,
  type Frame,
  type FrameType,
  type PingFrame,
  type RejectFrame,
  type WelcomeFrame,
} from "../protocol";
import type { CallHandler, ExecRun, ExecRunner, ExecSink } from "./capability";
import type { Logger } from "./log";
import type { Scheduler, TimerHandle, Transport } from "./transport";

const V = PROTOCOL_VERSION;

/** What one connection needs to run: who the agent is, what it can do, and its injected seams. */
export interface ConnectionDeps {
  agentName: string;
  agentVersion: string;
  /** The capability names to announce in the hello, derived from the registry by the runtime. */
  capabilities: string[];
  /** The shell runner, or null when this build has no exec capability. */
  execRunner: ExecRunner | null;
  /** The non-streaming capabilities, keyed by method name. */
  callHandlers: Map<string, CallHandler>;
  /** How often to send a ping and check the hub for silence. */
  heartbeatMs: number;
  /** How many heartbeat windows of silence mark the connection dead and worth redialing. */
  missedHeartbeatLimit: number;
  /** The largest declared frame payload this side will accept. */
  maxPayloadBytes: number;
  scheduler: Scheduler;
  log: Logger;
}

/** How a connection ended, handed to the reconnect loop so it can decide whether to reset backoff. */
export interface ConnectionOutcome {
  /** Whether the hub ever welcomed this connection. A connection that never welcomed is not stable. */
  welcomed: boolean;
  /** A human-readable reason the connection ended. */
  reason: string;
  /** How long the connection lasted, in the scheduler's clock. */
  durationMs: number;
}

// A precise dispatch table: every frame type maps to a handler that receives the already-narrowed
// frame. The one cast lives at the call site in handleMessage, where the runtime type and the table
// key are the same value but TypeScript cannot see that they line up.
type FrameOf<T extends FrameType> = Extract<Frame, { type: T }>;
type DispatchTable = { [T in FrameType]: (frame: FrameOf<T>) => void };

export class AgentConnection {
  private readonly transport: Transport;
  private readonly deps: ConnectionDeps;

  private welcomed = false;
  private ended = false;
  private readonly startedAt: number;
  private lastInboundAt: number;
  private heartbeatTimer: TimerHandle | null = null;

  // Everything in flight, so a cancel frame can reach one run and a dropped socket can reach them
  // all. A run is tracked from its exec frame until its exit; a call from its call frame until it
  // settles. Deleting an id from either map is also the signal that a late result must be dropped.
  private readonly runs = new Map<string, ExecRun>();
  private readonly calls = new Map<string, AbortController>();

  private resolveDone!: (outcome: ConnectionOutcome) => void;
  private readonly done: Promise<ConnectionOutcome>;
  private readonly dispatch: DispatchTable;

  constructor(transport: Transport, deps: ConnectionDeps) {
    this.transport = transport;
    this.deps = deps;
    this.startedAt = deps.scheduler.now();
    this.lastInboundAt = this.startedAt;
    this.done = new Promise<ConnectionOutcome>((resolve) => {
      this.resolveDone = resolve;
    });
    this.dispatch = this.buildDispatch();
  }

  /** Send the hello, start the heartbeat, and resolve when the connection ends. */
  run(): Promise<ConnectionOutcome> {
    // If the connection was ended before it ran — the runtime was stopped between the dial and here —
    // there is nothing to send and no heartbeat to start; hand back the outcome it already resolved.
    if (this.ended) {
      return this.done;
    }
    this.deps.log.log("info", "connecting", { agent: this.deps.agentName, capabilities: this.deps.capabilities });
    this.send({
      type: "hello",
      v: V,
      agent: this.deps.agentName,
      agentVersion: this.deps.agentVersion,
      capabilities: [...this.deps.capabilities],
    });
    this.heartbeatTimer = this.deps.scheduler.setInterval(() => this.onHeartbeatTick(), this.deps.heartbeatMs);
    return this.done;
  }

  /** Feed one raw text frame received on the transport. */
  handleMessage(raw: string): void {
    if (this.ended) {
      return;
    }
    const result = decodeFrame(raw, { maxPayloadBytes: this.deps.maxPayloadBytes });
    if (!result.ok) {
      this.deps.log.log("warn", "frame-rejected", { code: result.error.code, message: result.error.message });
      return;
    }
    // Any well-formed frame is proof the hub is alive, so it refreshes the liveness clock before it
    // is acted on — this is what lets a long silence, and not only a socket error, trigger a redial.
    this.lastInboundAt = this.deps.scheduler.now();
    const frame = result.frame;
    (this.dispatch[frame.type] as (f: Frame) => void)(frame);
  }

  /** Note that the transport closed or errored. Ends the connection and abandons everything in flight. */
  handleClose(reason: string): void {
    this.end(reason);
  }

  // --- Dispatch ---------------------------------------------------------------------------------

  private buildDispatch(): DispatchTable {
    const ignore = (): void => {
      // A frame that is the agent's to send, not to receive, arriving from the hub is not the agent's
      // to act on. It refreshed the liveness clock already; beyond that it is dropped.
    };
    return {
      welcome: (frame) => this.onWelcome(frame),
      reject: (frame) => this.onReject(frame),
      ping: (frame) => this.onPing(frame),
      pong: ignore,
      exec: (frame) => this.onExec(frame),
      cancel: (frame) => this.onCancel(frame),
      call: (frame) => this.onCall(frame),
      error: (frame) => this.onInboundError(frame),
      hello: ignore,
      stdout: ignore,
      stderr: ignore,
      exit: ignore,
      result: ignore,
    };
  }

  private onWelcome(frame: WelcomeFrame): void {
    this.welcomed = true;
    this.deps.log.log("info", "welcomed", { hubVersion: frame.hubVersion });
  }

  private onReject(frame: RejectFrame): void {
    this.deps.log.log("warn", "rejected", { reason: frame.reason });
    this.end(`hub rejected the connection: ${frame.reason}`);
  }

  private onPing(frame: PingFrame): void {
    this.send({ type: "pong", v: V, ts: frame.ts });
  }

  private onExec(frame: ExecFrame): void {
    const runner = this.deps.execRunner;
    if (runner === null) {
      this.send({ type: "error", v: V, id: frame.id, code: "unsupported", message: "this agent has no exec capability" });
      return;
    }
    const run = runner.start(
      { id: frame.id, shell: frame.shell, command: frame.command, cwd: frame.cwd, env: frame.env, distro: frame.distro },
      this.makeSink(frame.id),
    );
    this.runs.set(frame.id, run);
  }

  private onCancel(frame: CancelFrame): void {
    // The run reports its own end (with canceled set) through the sink; the core removes it then, not
    // here, so a cancel for an already-finished run is simply a no-op.
    this.runs.get(frame.id)?.cancel();
  }

  private onCall(frame: CallFrame): void {
    const handler = this.deps.callHandlers.get(frame.method);
    if (handler === undefined) {
      this.send({ type: "error", v: V, id: frame.id, code: "unknown-method", message: `no capability named ${frame.method}` });
      return;
    }
    const controller = new AbortController();
    this.calls.set(frame.id, controller);
    handler
      .handle(frame.params, { signal: controller.signal, log: this.deps.log })
      .then((outcome) => {
        // If the id is gone the call was abandoned when the socket dropped; its result is stale and
        // must not be sent, and there is no socket to send it on anyway.
        if (!this.calls.delete(frame.id)) {
          return;
        }
        if (outcome.ok) {
          this.send({ type: "result", v: V, id: frame.id, value: outcome.value, blob: outcome.blob ?? null });
        } else {
          this.send({ type: "error", v: V, id: frame.id, code: outcome.code, message: outcome.message });
        }
      })
      .catch((error: unknown) => {
        if (!this.calls.delete(frame.id)) {
          return;
        }
        this.send({
          type: "error",
          v: V,
          id: frame.id,
          code: "handler-threw",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private onInboundError(frame: ErrorFrame): void {
    // The agent makes no requests of the hub, so an inbound error answers nothing here; it is only
    // recorded, so the reason is legible afterwards in the local log.
    this.deps.log.log("warn", "hub-error", { id: frame.id, code: frame.code, message: frame.message });
  }

  // --- The per-run output sink ------------------------------------------------------------------

  private makeSink(id: string): ExecSink {
    let seq = 0;
    const finish = (): void => {
      this.runs.delete(id);
    };
    return {
      stdout: (chunk) => this.send({ type: "stdout", v: V, id, seq: seq++, chunk: encodeBytes(chunk) }),
      stderr: (chunk) => this.send({ type: "stderr", v: V, id, seq: seq++, chunk: encodeBytes(chunk) }),
      exit: (outcome) => {
        this.send({ type: "exit", v: V, id, code: outcome.code, signal: outcome.signal, canceled: outcome.canceled });
        finish();
      },
      fail: (code, message) => {
        this.send({ type: "error", v: V, id, code, message });
        finish();
      },
    };
  }

  // --- Heartbeat --------------------------------------------------------------------------------

  private onHeartbeatTick(): void {
    if (this.ended) {
      return;
    }
    const silentFor = this.deps.scheduler.now() - this.lastInboundAt;
    if (silentFor > this.deps.heartbeatMs * this.deps.missedHeartbeatLimit) {
      // The socket has not errored, but the hub has gone quiet past the window. Treat it as dead and
      // let the reconnect loop redial rather than trust a connection nothing is coming over.
      this.end("no traffic from the hub within the liveness window");
      return;
    }
    this.send({ type: "ping", v: V, ts: this.deps.scheduler.now() });
  }

  // --- Ending -----------------------------------------------------------------------------------

  private end(reason: string): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.heartbeatTimer !== null) {
      this.deps.scheduler.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Nothing in flight outlives the socket it was streaming over. Every run is cancelled and every
    // call is aborted; a run's cancel is guarded so one that throws does not stop the others. The
    // maps are cleared, which is also what makes a late call result recognise itself as abandoned.
    for (const run of this.runs.values()) {
      try {
        run.cancel();
      } catch (error) {
        this.deps.log.log("warn", "run-cancel-threw", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.runs.clear();
    for (const controller of this.calls.values()) {
      controller.abort();
    }
    this.calls.clear();

    try {
      this.transport.close();
    } catch {
      // already closed, or the transport threw on close — either way there is nothing more to do
    }

    this.deps.log.log("info", "connection-ended", { reason, welcomed: this.welcomed });
    this.resolveDone({ welcomed: this.welcomed, reason, durationMs: this.deps.scheduler.now() - this.startedAt });
  }

  private send(frame: Frame): void {
    if (this.ended) {
      return;
    }
    try {
      this.transport.send(encodeFrame(frame));
    } catch (error) {
      this.deps.log.log("warn", "send-failed", { type: frame.type, error: error instanceof Error ? error.message : String(error) });
      this.end("a send failed: the transport is gone");
    }
  }
}
