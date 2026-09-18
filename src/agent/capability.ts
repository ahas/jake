// The contract the shell runner implements so the connection core can dispatch to it. The shell is
// the agent's only capability; the core owns none of it, and hands every exec and cancel frame to the
// one registered runner. The core supplies the wire (framing, sequence numbers, sending); the runner
// supplies only spawning, streaming, and stopping.

import type { ShellKind } from "../protocol";

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

