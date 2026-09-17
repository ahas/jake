// The contracts a capability implements so the connection core can dispatch to it. The core owns no
// capability itself: the modules that run commands, take screenshots, fetch, and drive a browser
// each implement one of these and register it, and the core routes an inbound frame to whichever is
// registered. A capability the build leaves out is therefore simply absent from the registry — and
// so absent from the `hello` list the hub is told about — rather than a branch the core carries.
// The core supplies the wire (framing, sequence numbers, sending); a handler supplies only its work.

import type { EncodedBlob, ShellKind } from "../protocol";
import type { Logger } from "./log";

// --- Streaming: the shell runner (exec / cancel) -------------------------------------------------

/** A command to run, as the exec frame carried it. `id` ties every frame the run emits back to it. */
export interface ExecRequest {
  id: string;
  shell: ShellKind;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  distro: string | null;
}

/**
 * Where a run's output goes. The core hands one of these to the runner per run and owns everything
 * on the wire: it assigns each chunk its sequence number, encodes the bytes, and sends the frame.
 * The runner only pushes raw bytes as they arrive and, once, reports how the run ended. `exit` is a
 * natural or cancelled finish; `fail` is a run that never started (a bad shell, a spawn error).
 * Emitting after the connection is gone is a no-op, so a runner need not guard against a dropped
 * socket — the core has already abandoned the run.
 */
export interface ExecSink {
  stdout(chunk: Uint8Array): void;
  stderr(chunk: Uint8Array): void;
  exit(outcome: { code: number | null; signal: string | null; canceled: boolean }): void;
  fail(code: string, message: string): void;
}

/** A run in progress. The core keeps it so a cancel frame, or a dropped socket, can stop the run. */
export interface ExecRun {
  /** Stop the run, killing its whole process tree. The run still reports its end through the sink. */
  cancel(): void;
}

/**
 * The one component that turns an exec frame into a running command. Its `capabilities` are the
 * names it contributes to the hello list (for the shell runner, the shells it can run). `start`
 * begins a run and returns a handle the core can cancel.
 */
export interface ExecRunner {
  readonly capabilities: readonly string[];
  start(request: ExecRequest, sink: ExecSink): ExecRun;
}

// --- Non-streaming: the capability calls (call) --------------------------------------------------

/** What a call handler is given besides its parameters: a signal that fires when the work is abandoned. */
export interface CallContext {
  /** Aborted when the connection drops, so a handler can stop work that will never be delivered. */
  signal: AbortSignal;
  log: Logger;
}

/** The settled outcome of a capability call: a value with an optional binary blob, or a named error. */
export type CallOutcome =
  | { ok: true; value: unknown; blob?: EncodedBlob | null }
  | { ok: false; code: string; message: string };

/**
 * One non-streaming capability — a screenshot, a fetch, a browser method. Its `method` is both the
 * name it is invoked by and the name it contributes to the hello list. `handle` runs the call and
 * resolves with its outcome; the core turns that into a result or error frame. A handler that throws
 * is reported as a failure rather than crashing the agent.
 */
export interface CallHandler {
  readonly method: string;
  handle(params: unknown, ctx: CallContext): Promise<CallOutcome>;
}
