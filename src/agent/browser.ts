// The agent's side of the browser capability: an engine over a browser backend, plus the capability
// handlers that shape its outcomes. The browser is Microsoft Edge, launched by the backend with a
// remote-debugging endpoint and driven over CDP — no sidecar, no downloaded browser, nothing a
// compile cannot carry, so the whole capability lives inside the agent's own executable. This engine
// holds at most one browser session, brings it up lazily on the first call, keeps it only as long as
// calls keep coming, and never lets one failure become a crash. The backend and the driver it yields
// are seams, so the engine's lifecycle is driven on this machine by a fake backend, and a real
// Chromium-family browser exercises the driver separately. docs/architecture.md is canonical.

import type { EncodedBlob } from "../protocol";
import type { BrowserCallOutcome, BrowserDriver } from "./browser-ops";
import { dispatchBrowserCall } from "./browser-ops";
import type { CallContext, CallHandler, CallOutcome } from "./capability";
import type { Logger } from "./log";
import type { Scheduler, TimerHandle } from "./transport";

export type { BrowserCallOutcome } from "./browser-ops";

/** One live browser session: a driver to call, a promise that settles when the browser dies, and a
 *  way to end it. The backend yields one on `open`; the engine holds at most one at a time. */
export interface BrowserSession {
  readonly driver: BrowserDriver;
  /** Settles when the browser process exits, however it exits, so the engine can drop and relaunch it. */
  readonly closed: Promise<void>;
  /** End the browser now. Calling it more than once is harmless. */
  close(): void;
}

/** What a browser handler needs of the engine: run one operation and settle with its outcome. */
export interface BrowserCaller {
  call(op: string, params: unknown, signal: AbortSignal): Promise<BrowserCallOutcome>;
}

/** The source of browser sessions. `available` is false when no browser is installed on this machine. */
export interface BrowserBackend {
  /** Whether a browser is present to drive. When false, no browser capability is advertised. */
  available(): boolean;
  /** Launch the browser and return a driven session, or reject when it cannot be brought up. */
  open(): Promise<BrowserSession>;
}

/** What the engine needs: the backend, a clock, a log, the idle and per-call ceilings, and a hint. */
export interface BrowserEngineOptions {
  backend: BrowserBackend;
  scheduler: Scheduler;
  log: Logger;
  /** How long the browser may sit with no calls before it is shut down, in milliseconds. */
  idleMs: number;
  /** The wall-clock ceiling on one browser call before it is failed and the browser torn down. */
  callTimeoutMs: number;
  /** The message an unavailable call returns, telling 하스 what is needed to enable the browser. */
  installHint: string;
}

/**
 * The browser engine. It serialises calls — a single page cannot serve two overlapping navigations —
 * and holds one session across them, bringing it up on the first call and shutting it down after an
 * idle stretch. Every call is either answered by the browser, timed out (which tears the session down
 * so the next call is fresh), abandoned because the connection dropped, or failed because the browser
 * died or would not launch. It never throws to its caller.
 */
export class BrowserEngine implements BrowserCaller {
  private readonly opts: BrowserEngineOptions;

  private session: BrowserSession | null = null;
  // A generation tag on the live session, so a stale exit from a replaced session does not tear down
  // its successor and a timeout only ends the session it belongs to.
  private generation = 0;
  private idleTimer: TimerHandle | null = null;
  // Calls run one at a time; each waits for the one before it, whatever its outcome.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserEngineOptions) {
    this.opts = options;
  }

  /** Whether a browser is installed here. When false, no browser capability is advertised. */
  available(): boolean {
    return this.opts.backend.available();
  }

  /**
   * Run one browser call: ensure the browser is up, dispatch the operation, and settle when it
   * answers, the call times out, the connection is abandoned, or the browser dies. The result is the
   * driver's own outcome; a handler shapes it into a capability result.
   */
  call(op: string, params: unknown, signal: AbortSignal): Promise<BrowserCallOutcome> {
    if (!this.opts.backend.available()) {
      return Promise.resolve({ ok: false, code: "browser-unavailable", message: this.opts.installHint });
    }
    if (signal.aborted) {
      return Promise.resolve({ ok: false, code: "abandoned", message: "the connection was gone before the call started" });
    }
    const run = this.queue.then(
      () => this.runCall(op, params, signal),
      () => this.runCall(op, params, signal),
    );
    // The queue tracks completion only, never the outcome, so one call's result does not leak to the next.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Shut the browser down and forget it. Used at agent stop; a later call brings a fresh one up. */
  stop(): void {
    this.teardown("engine stopped");
  }

  // --- One call --------------------------------------------------------------------------------

  private async runCall(op: string, params: unknown, signal: AbortSignal): Promise<BrowserCallOutcome> {
    if (signal.aborted) {
      return { ok: false, code: "abandoned", message: "the connection dropped before the call started" };
    }
    let session: BrowserSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      return { ok: false, code: "browser-launch-failed", message: error instanceof Error ? error.message : String(error) };
    }
    this.clearIdle();
    const generation = this.generation;
    try {
      return await this.race(session, generation, op, params, signal);
    } finally {
      this.armIdleIfQuiet();
    }
  }

  private race(
    session: BrowserSession,
    generation: number,
    op: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<BrowserCallOutcome> {
    return new Promise<BrowserCallOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: BrowserCallOutcome): void => {
        if (done) return;
        done = true;
        this.opts.scheduler.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const timer = this.opts.scheduler.setTimeout(() => {
        // A call that never answered means a wedged page or a hung browser; tear the session down so
        // the next call is served by a fresh one rather than queuing behind the stuck one.
        this.opts.log.log("warn", "browser-call-timeout", { op, timeoutMs: this.opts.callTimeoutMs });
        settle({ ok: false, code: "browser-timeout", message: `browser call timed out after ${this.opts.callTimeoutMs} ms` });
        this.teardown(`call ${op} timed out`, generation);
      }, this.opts.callTimeoutMs);

      const onAbort = (): void => {
        settle({ ok: false, code: "abandoned", message: "the connection dropped before the call answered" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // If the browser dies mid-call, fail the call rather than waiting out the timeout.
      void session.closed.then(() => {
        settle({ ok: false, code: "browser-crashed", message: "the browser exited before the call answered" });
      });

      void dispatchBrowserCall(session.driver, op, params).then(
        (outcome) => settle(outcome),
        (error) => settle({ ok: false, code: "driver-error", message: error instanceof Error ? error.message : String(error) }),
      );
    });
  }

  // --- Session lifecycle -----------------------------------------------------------------------

  private async ensureSession(): Promise<BrowserSession> {
    if (this.session !== null) {
      return this.session;
    }
    const session = await this.opts.backend.open();
    this.session = session;
    const generation = ++this.generation;
    this.opts.log.log("info", "browser-session-started", { generation });
    void session.closed.then(() => {
      // Only drop the session if it is still the current one; a replaced session's exit is ignored.
      if (this.generation === generation && this.session === session) {
        this.session = null;
        this.clearIdle();
        this.opts.log.log("info", "browser-session-ended", { generation });
      }
    });
    return session;
  }

  private teardown(reason: string, generation?: number): void {
    if (generation !== undefined && generation !== this.generation) {
      return;
    }
    const session = this.session;
    this.session = null;
    this.generation++;
    this.clearIdle();
    if (session !== null) {
      try {
        session.close();
      } catch (error) {
        this.opts.log.log("warn", "browser-close-threw", { error: error instanceof Error ? error.message : String(error) });
      }
      this.opts.log.log("info", "browser-session-stopped", { reason });
    }
  }

  // --- Idle shutdown ---------------------------------------------------------------------------

  private armIdleIfQuiet(): void {
    if (this.session === null) {
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
 * them share the one engine, so they share the single browser it drives. A handler only forwards its
 * params to the engine and shapes the answer; the engine owns the session.
 */
export class BrowserHandler implements CallHandler {
  readonly method: string;

  constructor(
    method: string,
    private readonly op: string,
    private readonly engine: BrowserCaller,
    private readonly shape: (result: unknown) => CallOutcome,
  ) {
    this.method = method;
  }

  async handle(params: unknown, ctx: CallContext): Promise<CallOutcome> {
    const outcome = await this.engine.call(this.op, params, ctx.signal);
    if (!outcome.ok) {
      return { ok: false, code: outcome.code, message: outcome.message };
    }
    return this.shape(outcome.result);
  }
}

/** The plain shaper: a method's result becomes the capability result value, with no blob. */
function plainResult(result: unknown): CallOutcome {
  return { ok: true, value: result, blob: null };
}

/**
 * The screenshot shaper: the driver returns the PNG as base64 with its declared byte length, and the
 * handler carries that across as a labelled blob rather than re-encoding it. An image past the frame
 * payload cap is refused, the same bound every binary result answers to.
 */
function shotShaper(maxPayloadBytes: number): (result: unknown) => CallOutcome {
  return (result) => {
    if (typeof result !== "object" || result === null) {
      return { ok: false, code: "bad-browser-result", message: "shot result was not an object" };
    }
    const record = result as Record<string, unknown>;
    if (typeof record.png !== "string" || typeof record.bytes !== "number") {
      return { ok: false, code: "bad-browser-result", message: "shot result lacked png bytes" };
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
 * Build the browser capability handlers over one engine. The names are advertised only when the
 * engine reports a browser is present; the caller registers each and decides, from
 * `engine.available()`, whether to announce it.
 */
export function browserHandlers(engine: BrowserCaller, maxPayloadBytes: number): BrowserHandler[] {
  return [
    new BrowserHandler(`${BROWSER_PREFIX}navigate`, "navigate", engine, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}source`, "source", engine, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}shot`, "shot", engine, shotShaper(maxPayloadBytes)),
    new BrowserHandler(`${BROWSER_PREFIX}eval`, "eval", engine, plainResult),
    new BrowserHandler(`${BROWSER_PREFIX}fetch`, "fetch", engine, plainResult),
  ];
}
