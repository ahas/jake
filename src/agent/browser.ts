// The agent's side of the browser capability: a supervisor over the sidecar child process. The
// browser cannot be compiled into the agent's executable, so it lives in a separate, uncompiled
// program the installer lays down beside the exe with its own browser. This supervisor spawns that
// child lazily on the first browser call, talks to it over a line protocol on its standard streams —
// no listening port on 하스's machine — and shuts it down after an idle period so a Chromium is not
// left sitting in memory for nothing.
//
// Three failures are handled rather than crashed on. When the sidecar is not installed the supervisor
// is simply unavailable, its capabilities are never advertised, and a call that arrives anyway is a
// stated error naming how to install it. When the child dies mid-call — a crash, a wedged page a
// timeout tears down — every waiting call fails with the reason and the next call starts a fresh
// child. The child is spawned through an injected seam, so the whole lifecycle is driven on this
// machine by a fake child. docs/architecture.md is the canonical statement of the agent's shape.

import type { EncodedBlob } from "../protocol";
import type { RpcRequest, RpcResponse } from "../../sidecar/rpc";
import type { CallContext, CallHandler, CallOutcome } from "./capability";
import type { Logger } from "./log";
import type { Scheduler, TimerHandle } from "./transport";

/** One running sidecar child, seen the way the supervisor needs it: write a request line, read
 *  response lines, learn when it exits, and end it. Injected so a fake stands in for the real child. */
export interface SidecarChild {
  /** Write one request as a line (the newline is added here); harmless after the child is gone. */
  writeLine(line: string): void;
  /** The child's standard output, one response per line. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Settles when the child process ends, however it ended. */
  readonly exited: Promise<{ code: number | null }>;
  /** End the child. Calling it more than once is harmless. */
  kill(): void;
}

/** Spawns the sidecar child. Null is never returned; the supervisor treats a null spawner as "not
 *  installed". The real spawner runs the sidecar's bun against its directory. */
export interface SidecarSpawner {
  spawn(): SidecarChild;
}

/** The settled outcome of one browser call, before the handler shapes it into a capability result. */
export type SidecarCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/** What the supervisor needs. A null spawner means the sidecar is not installed on this machine. */
export interface BrowserSupervisorOptions {
  /** How to start the sidecar child, or null when it is not installed here. */
  spawner: SidecarSpawner | null;
  scheduler: Scheduler;
  log: Logger;
  /** How long the child may sit with no calls before it is shut down, in milliseconds. */
  idleMs: number;
  /** The wall-clock ceiling on one browser call before it is failed and the child torn down. */
  callTimeoutMs: number;
  /** The message an unavailable call returns, telling 하스 how to install the sidecar and browser. */
  installHint: string;
}

interface Pending {
  resolve(outcome: SidecarCallOutcome): void;
  timer: TimerHandle;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
}

// A running line splitter over the child's stdout: a read may hand over a partial line or several at
// once, so bytes are buffered and only complete lines are returned. Kept here so the agent stays
// independent of the sidecar package at runtime — only the wire types are shared, and those erase.
class Lines {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const out: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      if (line !== "") out.push(line);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
    return out;
  }
}

function parseResponse(line: string): RpcResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isInteger(record.id)) return null;
  if (record.ok === true) {
    return { id: record.id, ok: true, result: record.result };
  }
  if (record.ok === false) {
    const error = record.error;
    if (typeof error !== "object" || error === null) return null;
    const e = error as Record<string, unknown>;
    if (typeof e.code !== "string" || typeof e.message !== "string") return null;
    return { id: record.id, ok: false, error: { code: e.code, message: e.message } };
  }
  return null;
}

/**
 * The browser supervisor. It holds at most one sidecar child, correlates each call to its response by
 * a monotonic id, and keeps the child only as long as calls keep coming. Every call is either
 * answered by the child, timed out (which tears the child down so the next call is fresh), abandoned
 * because the connection dropped, or failed because the child died. It never throws to its caller.
 */
export class BrowserSupervisor {
  private readonly opts: BrowserSupervisorOptions;

  private child: SidecarChild | null = null;
  // A generation tag on the live child, so a stale exit from a replaced child does not tear down its
  // successor and a timeout only kills the child it belongs to.
  private generation = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: TimerHandle | null = null;

  constructor(options: BrowserSupervisorOptions) {
    this.opts = options;
  }

  /** Whether the sidecar is installed here. When false, no browser capability is advertised. */
  available(): boolean {
    return this.opts.spawner !== null;
  }

  /**
   * Run one browser call: ensure a child is up, send the request, and settle when the child answers,
   * the call times out, the connection is abandoned, or the child dies. The result is the sidecar's
   * own response mapped to an outcome; a handler shapes it into a capability result.
   */
  call(method: string, params: unknown, signal: AbortSignal): Promise<SidecarCallOutcome> {
    if (this.opts.spawner === null) {
      return Promise.resolve({ ok: false, code: "browser-unavailable", message: this.opts.installHint });
    }
    if (signal.aborted) {
      return Promise.resolve({ ok: false, code: "abandoned", message: "the connection was gone before the call started" });
    }

    let child: SidecarChild;
    try {
      child = this.ensureChild(this.opts.spawner);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        code: "sidecar-spawn-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.clearIdle();
    const id = this.nextId++;
    const request: RpcRequest = { id, method, params };

    return new Promise<SidecarCallOutcome>((resolve) => {
      const settle = (outcome: SidecarCallOutcome): void => {
        const entry = this.pending.get(id);
        if (entry === undefined) {
          return;
        }
        this.pending.delete(id);
        this.opts.scheduler.clearTimeout(entry.timer);
        if (entry.signal !== null && entry.onAbort !== null) {
          entry.signal.removeEventListener("abort", entry.onAbort);
        }
        this.armIdleIfQuiet();
        resolve(outcome);
      };

      const timer = this.opts.scheduler.setTimeout(() => {
        // A call that never answered means a wedged page or a hung child; tear the child down so the
        // next call is served by a fresh one rather than queuing behind the stuck one.
        this.opts.log.log("warn", "browser-call-timeout", { id, method, timeoutMs: this.opts.callTimeoutMs });
        settle({ ok: false, code: "browser-timeout", message: `browser call timed out after ${this.opts.callTimeoutMs} ms` });
        this.teardown(`call ${id} timed out`);
      }, this.opts.callTimeoutMs);

      const onAbort = (): void => {
        settle({ ok: false, code: "abandoned", message: "the connection dropped before the call answered" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, { resolve: settle, timer, onAbort, signal });

      try {
        child.writeLine(JSON.stringify(request));
      } catch (error) {
        settle({ ok: false, code: "sidecar-write-failed", message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  /** Shut the child down and forget it. Used at agent stop; a later call starts a fresh one. */
  stop(): void {
    this.teardown("supervisor stopped");
  }

  // --- Child lifecycle --------------------------------------------------------------------------

  private ensureChild(spawner: SidecarSpawner): SidecarChild {
    if (this.child !== null) {
      return this.child;
    }
    const child = spawner.spawn();
    this.child = child;
    const generation = ++this.generation;
    this.opts.log.log("info", "browser-sidecar-started", { generation });
    void this.readLoop(child, generation);
    void child.exited.then((end) => {
      if (this.generation === generation) {
        this.teardown(`sidecar exited (code ${end.code})`);
      }
    });
    return child;
  }

  private async readLoop(child: SidecarChild, generation: number): Promise<void> {
    const lines = new Lines();
    const reader = child.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (value === undefined) {
          continue;
        }
        for (const line of lines.push(value)) {
          if (this.generation !== generation) {
            return;
          }
          const response = parseResponse(line);
          if (response === null) {
            this.opts.log.log("warn", "browser-response-unparsed", { line: line.slice(0, 200) });
            continue;
          }
          const entry = this.pending.get(response.id);
          if (entry === undefined) {
            continue;
          }
          if (response.ok) {
            entry.resolve({ ok: true, result: response.result });
          } else {
            entry.resolve({ ok: false, code: response.error.code, message: response.error.message });
          }
        }
      }
    } catch (error) {
      this.opts.log.log("warn", "browser-read-threw", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      reader.releaseLock();
    }
  }

  private teardown(reason: string): void {
    const child = this.child;
    if (child === null) {
      // Still fail any calls that were somehow left waiting with no child.
      this.failAllPending(reason);
      this.clearIdle();
      return;
    }
    this.child = null;
    this.generation++;
    this.clearIdle();
    this.failAllPending(reason);
    try {
      child.kill();
    } catch (error) {
      this.opts.log.log("warn", "browser-kill-threw", { error: error instanceof Error ? error.message : String(error) });
    }
    this.opts.log.log("info", "browser-sidecar-stopped", { reason });
  }

  private failAllPending(reason: string): void {
    // Copy first: resolving mutates the map through each settle callback.
    for (const [, entry] of [...this.pending]) {
      entry.resolve({ ok: false, code: "sidecar-exited", message: reason });
    }
  }

  // --- Idle shutdown ----------------------------------------------------------------------------

  private armIdleIfQuiet(): void {
    if (this.pending.size > 0 || this.child === null) {
      return;
    }
    this.clearIdle();
    this.idleTimer = this.opts.scheduler.setTimeout(() => {
      this.idleTimer = null;
      this.teardown("idle");
    }, this.opts.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      this.opts.scheduler.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// --- Capability handlers ------------------------------------------------------------------------

/** The capability-name prefix every browser method is announced and invoked under. */
export const BROWSER_PREFIX = "browser.";

/**
 * One browser method as a non-streaming capability. Each method — navigate, source, shot, eval,
 * fetch — is its own named capability rather than one `browser` handler switching on a parameter, so
 * the hello list names exactly what the agent can do and the console invokes each directly. All of
 * them share the one supervisor, so they share the single browser the sidecar owns. A handler only
 * forwards its params to the supervisor and shapes the answer; the supervisor owns the child.
 */
export class BrowserHandler implements CallHandler {
  readonly method: string;

  constructor(
    method: string,
    private readonly op: string,
    private readonly supervisor: BrowserSupervisor,
    private readonly shape: (result: unknown) => CallOutcome,
  ) {
    this.method = method;
  }

  async handle(params: unknown, ctx: CallContext): Promise<CallOutcome> {
    const outcome = await this.supervisor.call(this.op, params, ctx.signal);
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, message: outcome.message };
    }
    return this.shape(outcome.result);
  }
}

/** The plain shaper: a method's JSON result becomes the capability result value, with no blob. */
function plainResult(result: unknown): CallOutcome {
  return { ok: true, value: result, blob: null };
}

/**
 * The screenshot shaper: the sidecar returns the PNG as base64 with its declared byte length, and the
 * handler carries that across as a labelled blob rather than re-encoding it. An image past the frame
 * payload cap is refused, the same bound every binary result answers to.
 */
function shotShaper(maxPayloadBytes: number): (result: unknown) => CallOutcome {
  return (result) => {
    if (typeof result !== "object" || result === null) {
      return { ok: false, code: "bad-sidecar-result", message: "shot result was not an object" };
    }
    const record = result as Record<string, unknown>;
    if (typeof record.png !== "string" || typeof record.bytes !== "number") {
      return { ok: false, code: "bad-sidecar-result", message: "shot result lacked png bytes" };
    }
    if (record.bytes > maxPayloadBytes) {
      return {
        ok: false,
        code: "payload-too-large",
        message: `screenshot is ${record.bytes} bytes, over the ${maxPayloadBytes}-byte frame cap`,
      };
    }
    const blob: EncodedBlob = { bytes: record.bytes, base64: record.png, contentType: "image/png" };
    return { ok: true, value: { bytes: record.bytes }, blob };
  };
}

/**
 * Build the browser capability handlers over one supervisor. The names are advertised only when the
 * supervisor reports the sidecar is installed; the caller registers each and decides, from
 * `supervisor.available()`, whether to announce it.
 */
export function browserHandlers(supervisor: BrowserSupervisor, maxPayloadBytes: number): BrowserHandler[] {
  return [
    new BrowserHandler(`${BROWSER_PREFIX}navigate`, "navigate", supervisor, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}source`, "source", supervisor, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}shot`, "shot", supervisor, shotShaper(maxPayloadBytes)),
    new BrowserHandler(`${BROWSER_PREFIX}eval`, "eval", supervisor, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}fetch`, "fetch", supervisor, plainResult),
  ];
}

// --- The real spawner ---------------------------------------------------------------------------

/**
 * The production spawner: run the sidecar's own bun against its directory as a child, piping its
 * standard input and output so the supervisor writes requests and reads responses over them. Its
 * standard error is left to inherit, so a sidecar that cannot start says why on the agent's console.
 * The command and working directory are settled by the caller from where the installer laid the
 * sidecar down.
 */
export function bunSidecarSpawner(command: readonly string[], cwd: string): SidecarSpawner {
  return {
    spawn(): SidecarChild {
      const proc = Bun.spawn([...command], {
        cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // Pass the environment explicitly, the way the exec spawner does, so the child sees the same
        // configuration this process holds — the sidecar reads its browser location from it.
        env: { ...process.env },
      });
      return {
        writeLine(line: string): void {
          proc.stdin.write(`${line}\n`);
          proc.stdin.flush();
        },
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        exited: proc.exited.then(() => ({ code: proc.exitCode })),
        kill(): void {
          proc.kill();
        },
      };
    },
  };
}
