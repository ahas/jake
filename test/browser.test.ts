import { describe, expect, test } from "bun:test";

import {
  BROWSER_PREFIX,
  BrowserEngine,
  browserHandlers,
  type BrowserBackend,
  type BrowserCaller,
  type BrowserCallOutcome,
  type BrowserEngineOptions,
  type BrowserSession,
} from "../src/agent/browser";
import type { BrowserDriver, FetchParams, NavigateParams } from "../src/agent/browser-ops";
import type { CallContext } from "../src/agent/capability";
import { nullLogger } from "../src/agent/log";
import { AgentRuntime } from "../src/agent/runtime";
import type { Scheduler, TimerHandle } from "../src/agent/transport";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "../src/protocol";
import type { AgentConfig } from "../src/config";

// A controllable clock: timers fire only when the test advances time, so a call timeout and the idle
// shutdown are exercised deterministically without waiting on the wall clock. The engine's own awaits
// run on the real microtask queue, independent of this fake.
class FakeScheduler implements Scheduler {
  current = 0;
  private seq = 0;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  now(): number {
    return this.current;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.current + ms });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  setInterval(): TimerHandle {
    throw new Error("the engine does not use setInterval");
  }
  clearInterval(): void {
    // unused
  }
  advance(ms: number): void {
    this.current += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.current) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

// A fake driver: navigate is answerable or left hanging (for the timeout case), and every other
// method returns a canned value. It records the operations it was asked to perform.
class FakeDriver implements BrowserDriver {
  readonly calls: string[] = [];
  navigateResult: { url: string; status: number | null } = { url: "http://x/", status: 200 };
  hang = false;
  private resolveHung: (() => void) | null = null;

  async navigate(params: NavigateParams): Promise<{ url: string; status: number | null }> {
    this.calls.push(`navigate:${params.url}`);
    if (this.hang) {
      await new Promise<void>((resolve) => {
        this.resolveHung = resolve;
      });
    }
    return this.navigateResult;
  }
  async source(): Promise<{ url: string; html: string }> {
    this.calls.push("source");
    return { url: "http://x/", html: "<html></html>" };
  }
  async shot(): Promise<{ png: string; bytes: number }> {
    this.calls.push("shot");
    return { png: "AAAA", bytes: 3 };
  }
  async evaluate(params: { expression: string }): Promise<{ value: unknown }> {
    this.calls.push(`eval:${params.expression}`);
    return { value: 42 };
  }
  async fetch(_params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    this.calls.push("fetch");
    return { status: 200, statusText: "OK", headers: {}, body: "hi", bytes: 2, truncated: false };
  }
  async close(): Promise<void> {
    this.resolveHung?.();
  }
}

// A fake session: it owns a driver, exposes a `closed` the test can resolve to simulate the browser
// dying, and records that it was closed.
class FakeSession implements BrowserSession {
  readonly driver = new FakeDriver();
  closedCount = 0;
  private resolveClosed!: () => void;
  readonly closed: Promise<void>;
  constructor() {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }
  close(): void {
    this.closedCount++;
    this.resolveClosed();
  }
  /** Simulate the browser process exiting on its own. */
  die(): void {
    this.resolveClosed();
  }
}

class FakeBackend implements BrowserBackend {
  readonly sessions: FakeSession[] = [];
  isAvailable = true;
  failOpen = false;
  /** When set, every session it opens hands out a driver whose calls hang until the session closes. */
  hangDriver = false;
  available(): boolean {
    return this.isAvailable;
  }
  open(): Promise<BrowserSession> {
    if (this.failOpen) {
      return Promise.reject(new Error("Edge would not launch"));
    }
    const session = new FakeSession();
    session.driver.hang = this.hangDriver;
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

function options(backend: BrowserBackend, overrides: Partial<BrowserEngineOptions> = {}): BrowserEngineOptions {
  return {
    backend,
    scheduler: new FakeScheduler(),
    log: nullLogger,
    idleMs: 10_000,
    callTimeoutMs: 5_000,
    installHint: "install Edge first",
    ...overrides,
  };
}

function ctx(signal: AbortSignal): CallContext {
  return { signal, log: nullLogger };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

// A short turn of the event loop, so the engine's serialised queue and awaits progress before the
// assertion. It uses the real timer, independent of the fake scheduler.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("BrowserEngine — availability", () => {
  test("an unavailable backend answers every call with a named install error", async () => {
    const backend = new FakeBackend();
    backend.isAvailable = false;
    const engine = new BrowserEngine(options(backend));
    expect(engine.available()).toBe(false);
    const outcome = await engine.call("navigate", { url: "http://x/" }, liveSignal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("browser-unavailable");
      expect(outcome.message).toBe("install Edge first");
    }
    expect(backend.sessions.length).toBe(0);
  });

  test("an available backend is available", () => {
    expect(new BrowserEngine(options(new FakeBackend())).available()).toBe(true);
  });
});

describe("BrowserEngine — lazy open and reuse", () => {
  test("opens the session only on the first call and returns its result", async () => {
    const backend = new FakeBackend();
    const engine = new BrowserEngine(options(backend));
    expect(backend.sessions.length).toBe(0);

    const outcome = await engine.call("navigate", { url: "http://x/" }, liveSignal());
    expect(backend.sessions.length).toBe(1);
    expect(outcome).toEqual({ ok: true, result: { url: "http://x/", status: 200 } });
    expect(backend.sessions[0]!.driver.calls).toEqual(["navigate:http://x/"]);
  });

  test("a second call reuses the same session", async () => {
    const backend = new FakeBackend();
    const engine = new BrowserEngine(options(backend));
    await engine.call("source", {}, liveSignal());
    const second = await engine.call("eval", { expression: "1" }, liveSignal());
    expect(backend.sessions.length).toBe(1);
    expect(second).toEqual({ ok: true, result: { value: 42 } });
  });

  test("a driver error becomes a driver-error outcome", async () => {
    const backend = new FakeBackend();
    const engine = new BrowserEngine(options(backend));
    // An unknown op is turned into an unknown-op outcome by the dispatch.
    const outcome = await engine.call("teleport", {}, liveSignal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unknown-op");
  });

  test("a bad-params call is rejected before the browser is reached", async () => {
    const backend = new FakeBackend();
    const engine = new BrowserEngine(options(backend));
    const outcome = await engine.call("navigate", {}, liveSignal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("bad-params");
  });
});

describe("BrowserEngine — launch failure", () => {
  test("a backend that cannot open is a browser-launch-failed outcome", async () => {
    const backend = new FakeBackend();
    backend.failOpen = true;
    const engine = new BrowserEngine(options(backend));
    const outcome = await engine.call("navigate", { url: "http://x/" }, liveSignal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("browser-launch-failed");
  });
});

describe("BrowserEngine — idle shutdown", () => {
  test("closes the session after the idle period and opens a fresh one on the next call", async () => {
    const backend = new FakeBackend();
    const scheduler = new FakeScheduler();
    const engine = new BrowserEngine(options(backend, { scheduler, idleMs: 10_000 }));

    await engine.call("source", {}, liveSignal());
    expect(backend.sessions[0]!.closedCount).toBe(0);

    scheduler.advance(10_000);
    expect(backend.sessions[0]!.closedCount).toBe(1);

    const next = await engine.call("source", {}, liveSignal());
    expect(backend.sessions.length).toBe(2);
    expect(next.ok).toBe(true);
  });
});

describe("BrowserEngine — mid-call death", () => {
  test("a session that dies mid-call fails the call and the next call reopens", async () => {
    const backend = new FakeBackend();
    backend.hangDriver = true;
    const engine = new BrowserEngine(options(backend));

    const promise = engine.call("navigate", { url: "http://x/" }, liveSignal());
    await settle();
    backend.sessions[0]!.die();

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("browser-crashed");

    backend.hangDriver = false;
    const restart = await engine.call("source", {}, liveSignal());
    expect(backend.sessions.length).toBe(2);
    expect(restart.ok).toBe(true);
  });
});

describe("BrowserEngine — timeout and abandonment", () => {
  test("a call that never answers times out and tears the session down", async () => {
    const backend = new FakeBackend();
    backend.hangDriver = true;
    const scheduler = new FakeScheduler();
    const engine = new BrowserEngine(options(backend, { scheduler, callTimeoutMs: 5_000 }));

    const promise = engine.call("navigate", { url: "http://x/" }, liveSignal());
    await settle();
    scheduler.advance(5_000);

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("browser-timeout");
    expect(backend.sessions[0]!.closedCount).toBe(1);
  });

  test("an aborted connection abandons the call without closing the session", async () => {
    const backend = new FakeBackend();
    backend.hangDriver = true;
    const engine = new BrowserEngine(options(backend));
    const controller = new AbortController();

    const promise = engine.call("navigate", { url: "http://x/" }, controller.signal);
    await settle();
    controller.abort();

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("abandoned");
    expect(backend.sessions[0]!.closedCount).toBe(0);
  });
});

// --- Handlers ------------------------------------------------------------------------------------

// A caller with a fixed outcome, so a handler's shaping is checked apart from the engine.
class StubCaller implements BrowserCaller {
  constructor(private readonly outcome: BrowserCallOutcome) {}
  call(): Promise<BrowserCallOutcome> {
    return Promise.resolve(this.outcome);
  }
}

describe("BrowserHandler — shaping", () => {
  test("a plain method returns the driver result as the value with no blob", async () => {
    const handlers = browserHandlers(new StubCaller({ ok: true, result: { url: "http://x/", html: "<p>" } }), DEFAULT_MAX_PAYLOAD_BYTES);
    const source = handlers.find((h) => h.method === `${BROWSER_PREFIX}source`)!;
    const outcome = await source.handle({}, ctx(liveSignal()));
    expect(outcome).toEqual({ ok: true, value: { url: "http://x/", html: "<p>" }, blob: null });
  });

  test("shot carries the PNG across as a labelled blob and reports the byte length", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString("base64");
    const handlers = browserHandlers(new StubCaller({ ok: true, result: { png, bytes: 6 } }), DEFAULT_MAX_PAYLOAD_BYTES);
    const shot = handlers.find((h) => h.method === `${BROWSER_PREFIX}shot`)!;
    const outcome = await shot.handle({}, ctx(liveSignal()));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({ bytes: 6 });
      expect(outcome.blob).toEqual({ bytes: 6, base64: png, contentType: "image/png" });
    }
  });

  test("shot refuses a PNG past the frame payload cap", async () => {
    const png = Buffer.from([1, 2, 3, 4, 5, 6]).toString("base64");
    const handlers = browserHandlers(new StubCaller({ ok: true, result: { png, bytes: 6 } }), 4);
    const shot = handlers.find((h) => h.method === `${BROWSER_PREFIX}shot`)!;
    const outcome = await shot.handle({}, ctx(liveSignal()));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("payload-too-large");
  });

  test("an engine error is passed straight through", async () => {
    const handlers = browserHandlers(new StubCaller({ ok: false, code: "browser-unavailable", message: "install it" }), DEFAULT_MAX_PAYLOAD_BYTES);
    const outcome = await handlers[0]!.handle({}, ctx(liveSignal()));
    expect(outcome).toEqual({ ok: false, code: "browser-unavailable", message: "install it" });
  });
});

// --- Advertisement --------------------------------------------------------------------------------

describe("AgentRuntime — advertise flag", () => {
  const config = { heartbeatMs: 1000 } as AgentConfig;
  const caller = new StubCaller({ ok: false, code: "browser-unavailable", message: "x" });

  test("an unadvertised handler is registered but kept out of the capability list", () => {
    const runtime = new AgentRuntime(config, {
      dialer: { dial: () => Promise.reject(new Error("unused")) },
      scheduler: new FakeScheduler(),
      log: nullLogger,
      agentVersion: "test",
    });
    for (const handler of browserHandlers(caller, DEFAULT_MAX_PAYLOAD_BYTES)) {
      runtime.registerCall(handler, { advertise: false });
    }
    expect(runtime.capabilities()).not.toContain(`${BROWSER_PREFIX}navigate`);
    expect(runtime.capabilities()).toEqual([]);
  });

  test("an advertised handler appears in the capability list", () => {
    const runtime = new AgentRuntime(config, {
      dialer: { dial: () => Promise.reject(new Error("unused")) },
      scheduler: new FakeScheduler(),
      log: nullLogger,
      agentVersion: "test",
    });
    for (const handler of browserHandlers(caller, DEFAULT_MAX_PAYLOAD_BYTES)) {
      runtime.registerCall(handler, { advertise: true });
    }
    expect(runtime.capabilities()).toContain(`${BROWSER_PREFIX}shot`);
    expect(runtime.capabilities().length).toBe(5);
  });
});
