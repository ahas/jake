import { describe, expect, test } from "bun:test";

import {
  BROWSER_PREFIX,
  BrowserHandler,
  BrowserSupervisor,
  browserHandlers,
  type BrowserSupervisorOptions,
  type SidecarCallOutcome,
  type SidecarChild,
  type SidecarSpawner,
} from "../src/agent/browser";
import type { CallContext } from "../src/agent/capability";
import { nullLogger } from "../src/agent/log";
import { AgentRuntime } from "../src/agent/runtime";
import type { Scheduler, TimerHandle } from "../src/agent/transport";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "../src/protocol";
import type { AgentConfig } from "../src/config";

// A controllable clock: timers fire only when the test advances time, so a call timeout and the idle
// shutdown are exercised deterministically without waiting on the wall clock. The read loop that
// delivers responses runs on the real event loop, independent of this fake.
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
    throw new Error("the supervisor does not use setInterval");
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

// A fake sidecar child: it records the request lines written to it, lets a test emit response lines
// on its stdout, and settles its exit when killed or when the test ends it — standing in for a real
// spawned process without one.
class FakeChild implements SidecarChild {
  readonly writes: string[] = [];
  killed = false;
  private ended = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (value: { code: number | null }) => void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null }>;

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  writeLine(line: string): void {
    this.writes.push(line);
  }
  kill(): void {
    this.killed = true;
    this.end(143);
  }
  /** The id the sidecar would echo for the nth request the supervisor wrote. */
  requestId(index: number): number {
    return (JSON.parse(this.writes[index]!) as { id: number }).id;
  }
  /** Emit a success response for the request at `index`. */
  respond(index: number, result: unknown): void {
    this.emit(JSON.stringify({ id: this.requestId(index), ok: true, result }));
  }
  emit(line: string): void {
    this.controller.enqueue(new TextEncoder().encode(`${line}\n`));
  }
  end(code: number | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    try {
      this.controller.close();
    } catch {
      // already closed
    }
    this.resolveExit({ code });
  }
}

class FakeSpawner implements SidecarSpawner {
  readonly children: FakeChild[] = [];
  spawn(): SidecarChild {
    const child = new FakeChild();
    this.children.push(child);
    return child;
  }
}

function options(overrides: Partial<BrowserSupervisorOptions> = {}): BrowserSupervisorOptions {
  return {
    spawner: new FakeSpawner(),
    scheduler: new FakeScheduler(),
    log: nullLogger,
    idleMs: 10_000,
    callTimeoutMs: 5_000,
    installHint: "install the sidecar first",
    ...overrides,
  };
}

function ctx(signal: AbortSignal): CallContext {
  return { signal, log: nullLogger };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

// A short turn of the event loop, so an emitted response is read and correlated before the assertion.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("BrowserSupervisor — availability", () => {
  test("a null spawner is unavailable and every call is a named install error", async () => {
    const supervisor = new BrowserSupervisor(options({ spawner: null }));
    expect(supervisor.available()).toBe(false);
    const outcome = await supervisor.call("navigate", { url: "http://x/" }, liveSignal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("browser-unavailable");
      expect(outcome.message).toBe("install the sidecar first");
    }
  });

  test("a spawner present is available", () => {
    expect(new BrowserSupervisor(options()).available()).toBe(true);
  });
});

describe("BrowserSupervisor — lazy start and correlation", () => {
  test("spawns the child only on the first call and returns the matching response", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));
    expect(spawner.children.length).toBe(0);

    const promise = supervisor.call("navigate", { url: "http://x/" }, liveSignal());
    expect(spawner.children.length).toBe(1);
    const child = spawner.children[0]!;
    await settle();
    child.respond(0, { url: "http://x/", status: 200 });

    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, result: { url: "http://x/", status: 200 } });
    expect(JSON.parse(child.writes[0]!)).toMatchObject({ method: "navigate", params: { url: "http://x/" } });
  });

  test("a second call reuses the same child", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));

    const first = supervisor.call("source", {}, liveSignal());
    await settle();
    spawner.children[0]!.respond(0, { url: "http://x/", html: "<p>" });
    await first;

    const second = supervisor.call("eval", { expression: "1" }, liveSignal());
    expect(spawner.children.length).toBe(1);
    await settle();
    spawner.children[0]!.respond(1, { value: 1 });
    expect((await second).ok).toBe(true);
  });

  test("a sidecar error response is passed through as an outcome error", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));
    const promise = supervisor.call("navigate", { url: "nope" }, liveSignal());
    await settle();
    spawner.children[0]!.emit(JSON.stringify({ id: spawner.children[0]!.requestId(0), ok: false, error: { code: "driver-error", message: "timeout" } }));
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, code: "driver-error", message: "timeout" });
  });
});

describe("BrowserSupervisor — idle shutdown", () => {
  test("shuts the child down after the idle period and starts a fresh one on the next call", async () => {
    const spawner = new FakeSpawner();
    const scheduler = new FakeScheduler();
    const supervisor = new BrowserSupervisor(options({ spawner, scheduler, idleMs: 10_000 }));

    const promise = supervisor.call("source", {}, liveSignal());
    await settle();
    spawner.children[0]!.respond(0, { url: "http://x/", html: "" });
    await promise;

    expect(spawner.children[0]!.killed).toBe(false);
    scheduler.advance(10_000);
    expect(spawner.children[0]!.killed).toBe(true);

    const next = supervisor.call("source", {}, liveSignal());
    expect(spawner.children.length).toBe(2);
    await settle();
    spawner.children[1]!.respond(0, { url: "http://y/", html: "" });
    expect((await next).ok).toBe(true);
  });
});

describe("BrowserSupervisor — mid-call death and restart", () => {
  test("a child that dies mid-call fails the waiting call and the next call restarts it", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));

    const promise = supervisor.call("navigate", { url: "http://x/" }, liveSignal());
    await settle();
    spawner.children[0]!.end(1); // the child crashed before answering

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("sidecar-exited");

    const restart = supervisor.call("navigate", { url: "http://x/" }, liveSignal());
    expect(spawner.children.length).toBe(2);
    await settle();
    spawner.children[1]!.respond(0, { url: "http://x/", status: 200 });
    expect((await restart).ok).toBe(true);
  });

  test("a death fails every call that was in flight at once", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));

    const a = supervisor.call("source", {}, liveSignal());
    const b = supervisor.call("eval", { expression: "1" }, liveSignal());
    await settle();
    spawner.children[0]!.end(null);

    for (const outcome of await Promise.all([a, b])) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("sidecar-exited");
    }
  });
});

describe("BrowserSupervisor — timeout and abandonment", () => {
  test("a call that never answers times out and tears the child down", async () => {
    const spawner = new FakeSpawner();
    const scheduler = new FakeScheduler();
    const supervisor = new BrowserSupervisor(options({ spawner, scheduler, callTimeoutMs: 5_000 }));

    const promise = supervisor.call("navigate", { url: "http://x/" }, liveSignal());
    await settle();
    scheduler.advance(5_000);

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("browser-timeout");
    expect(spawner.children[0]!.killed).toBe(true);
  });

  test("an aborted connection abandons the call without killing the child", async () => {
    const spawner = new FakeSpawner();
    const supervisor = new BrowserSupervisor(options({ spawner }));
    const controller = new AbortController();

    const promise = supervisor.call("source", {}, controller.signal);
    await settle();
    controller.abort();

    const outcome = await promise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("abandoned");
    expect(spawner.children[0]!.killed).toBe(false);
  });
});

// --- Handlers ------------------------------------------------------------------------------------

// A supervisor stub with a fixed outcome, so a handler's shaping is checked apart from the child.
class StubSupervisor extends BrowserSupervisor {
  constructor(private readonly outcome: SidecarCallOutcome) {
    super(options({ spawner: null }));
  }
  override call(): Promise<SidecarCallOutcome> {
    return Promise.resolve(this.outcome);
  }
}

describe("BrowserHandler — shaping", () => {
  test("a plain method returns the sidecar result as the value with no blob", async () => {
    const handler = new BrowserHandler(`${BROWSER_PREFIX}source`, "source", new StubSupervisor({ ok: true, result: { url: "http://x/", html: "<p>" } }), (r) => ({ ok: true, value: r, blob: null }));
    const outcome = await handler.handle({}, ctx(liveSignal()));
    expect(outcome).toEqual({ ok: true, value: { url: "http://x/", html: "<p>" }, blob: null });
  });

  test("shot carries the PNG across as a labelled blob and reports the byte length", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString("base64");
    const handlers = browserHandlers(new StubSupervisor({ ok: true, result: { png, bytes: 6 } }), DEFAULT_MAX_PAYLOAD_BYTES);
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
    const handlers = browserHandlers(new StubSupervisor({ ok: true, result: { png, bytes: 6 } }), 4);
    const shot = handlers.find((h) => h.method === `${BROWSER_PREFIX}shot`)!;
    const outcome = await shot.handle({}, ctx(liveSignal()));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("payload-too-large");
  });

  test("a supervisor error is passed straight through", async () => {
    const handlers = browserHandlers(new StubSupervisor({ ok: false, code: "browser-unavailable", message: "install it" }), DEFAULT_MAX_PAYLOAD_BYTES);
    const outcome = await handlers[0]!.handle({}, ctx(liveSignal()));
    expect(outcome).toEqual({ ok: false, code: "browser-unavailable", message: "install it" });
  });
});

// --- Advertisement --------------------------------------------------------------------------------

describe("AgentRuntime — advertise flag", () => {
  const config = { heartbeatMs: 1000 } as AgentConfig;

  test("an unadvertised handler is registered but kept out of the capability list", () => {
    const runtime = new AgentRuntime(config, {
      dialer: { dial: () => Promise.reject(new Error("unused")) },
      scheduler: new FakeScheduler(),
      log: nullLogger,
      agentVersion: "test",
    });
    const supervisor = new BrowserSupervisor(options({ spawner: null }));
    for (const handler of browserHandlers(supervisor, DEFAULT_MAX_PAYLOAD_BYTES)) {
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
    const supervisor = new BrowserSupervisor(options());
    for (const handler of browserHandlers(supervisor, DEFAULT_MAX_PAYLOAD_BYTES)) {
      runtime.registerCall(handler, { advertise: true });
    }
    expect(runtime.capabilities()).toContain(`${BROWSER_PREFIX}shot`);
    expect(runtime.capabilities().length).toBe(5);
  });
});
