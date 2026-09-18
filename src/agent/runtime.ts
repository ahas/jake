// The agent's outermost layer: the shell-runner registration and the forever reconnect loop. The
// runner is registered before the agent runs, so the hello list is exactly the shells it can run.
// The loop dials the hub, runs one connection over the socket it gets, and when that
// connection ends — for any reason — waits out a backoff and dials again, without end. A connection
// that stayed up long enough to be worth trusting resets the backoff, so an occasional flap does not
// push the delay toward its ceiling while a genuine outage still does. The dialer, the clock, and
// the randomness are injected, so the whole loop is driven on Linux by fakes.

import type { AgentConfig } from "../config";
import { backoffDelay, type BackoffOptions } from "./backoff";
import type { ExecRunner } from "./capability";
import { AgentConnection, type ConnectionDeps, type ConnectionOutcome } from "./connection";
import type { Logger } from "./log";
import type { Dialer, Scheduler, Transport, TransportEvents } from "./transport";

/** The injected seams and knobs the runtime needs beyond the agent's own config. */
export interface RuntimeDeps {
  dialer: Dialer;
  scheduler: Scheduler;
  log: Logger;
  /** This agent build's version, announced in the hello. */
  agentVersion: string;
  /** Called when the hub sends a leave frame, to erase the agent and depart. */
  onLeave?: () => void;
  /** The randomness the backoff jitters with. Defaults to Math.random. */
  random?: () => number;
  /** The backoff schedule. A sensible default is used when omitted. */
  backoff?: BackoffOptions;
  /** How many heartbeat windows of silence mark a connection dead. */
  missedHeartbeatLimit?: number;
  /** A welcomed connection that lasted at least this long resets the backoff. */
  stableResetMs?: number;
}

const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, capMs: 60_000, factor: 2 };
const DEFAULT_MISSED_HEARTBEAT_LIMIT = 3;
// A cap on the attempt counter so `factor ** attempt` cannot overflow on a very long outage; the
// delay is already clamped to capMs well before this, so the counter only needs to stop growing.
const MAX_ATTEMPT = 30;

export class AgentRuntime {
  private readonly config: AgentConfig;
  private readonly deps: RuntimeDeps;

  private execRunner: ExecRunner | null = null;

  private stopped = false;
  private currentConnection: AgentConnection | null = null;
  private wakeSleep: (() => void) | null = null;

  constructor(config: AgentConfig, deps: RuntimeDeps) {
    this.config = config;
    this.deps = deps;
  }

  /** Register the shell runner. Exactly one may be registered. */
  registerExec(runner: ExecRunner): void {
    if (this.execRunner !== null) {
      throw new Error("an exec runner is already registered");
    }
    this.execRunner = runner;
  }

  /** The capability names to announce: the shells the registered runner can run. */
  capabilities(): string[] {
    return this.execRunner === null ? [] : [...this.execRunner.capabilities];
  }

  /** Dial and redial forever, running one connection at a time, until `stop` is called. */
  async run(): Promise<void> {
    const backoff = this.deps.backoff ?? DEFAULT_BACKOFF;
    const random = this.deps.random ?? Math.random;
    const stableResetMs = this.deps.stableResetMs ?? this.config.heartbeatMs * 2;
    let attempt = 0;

    while (!this.stopped) {
      const outcome = await this.runOnce();
      if (outcome !== null && outcome.welcomed && outcome.durationMs >= stableResetMs) {
        attempt = 0;
      }
      if (this.stopped) {
        break;
      }
      const delay = backoffDelay(attempt, backoff, random);
      attempt = Math.min(attempt + 1, MAX_ATTEMPT);
      this.deps.log.log("info", "redial-scheduled", { attempt, delayMs: delay });
      await this.sleep(delay);
    }
    this.deps.log.log("info", "runtime-stopped", {});
  }

  /** Stop the loop: end the live connection if any, and cut short a pending backoff sleep. */
  stop(): void {
    this.stopped = true;
    this.currentConnection?.handleClose("agent stopping");
    this.wakeSleep?.();
  }

  // --- Internals --------------------------------------------------------------------------------

  private async runOnce(): Promise<ConnectionOutcome | null> {
    // The events forward to the connection, which does not exist until the dial resolves. They
    // capture it by closure so a frame that arrives the instant the socket opens still lands.
    let connection: AgentConnection | null = null;
    const events: TransportEvents = {
      onMessage: (raw) => connection?.handleMessage(raw),
      onClose: (code, reason) => connection?.handleClose(`socket closed (code ${code}${reason ? `: ${reason}` : ""})`),
      onError: (error) => connection?.handleClose(`socket error: ${error instanceof Error ? error.message : String(error)}`),
    };

    let transport: Transport;
    try {
      transport = await this.deps.dialer.dial(this.config.hubUrl, this.config.secret, events);
    } catch (error) {
      this.deps.log.log("warn", "dial-failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }

    const connectionDeps: ConnectionDeps = {
      agentName: this.config.agentName,
      agentVersion: this.deps.agentVersion,
      capabilities: this.capabilities(),
      execRunner: this.execRunner,
      heartbeatMs: this.config.heartbeatMs,
      missedHeartbeatLimit: this.deps.missedHeartbeatLimit ?? DEFAULT_MISSED_HEARTBEAT_LIMIT,
      maxPayloadBytes: this.config.maxPayloadBytes,
      onLeave: this.deps.onLeave,
      scheduler: this.deps.scheduler,
      log: this.deps.log,
    };
    connection = new AgentConnection(transport, connectionDeps);
    this.currentConnection = connection;

    // If stop() arrived between the dial and here, end the connection at once rather than run it.
    if (this.stopped) {
      connection.handleClose("agent stopping");
    }

    const outcome = await connection.run();
    this.currentConnection = null;
    return outcome;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.deps.scheduler.setTimeout(() => {
        this.wakeSleep = null;
        resolve();
      }, ms);
      this.wakeSleep = () => {
        this.deps.scheduler.clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
    });
  }
}
