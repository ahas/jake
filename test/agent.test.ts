import { describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/config";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  decodeBytes,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "../src/protocol";
import { backoffDelay } from "../src/agent/backoff";
import type { ExecRequest, ExecRun, ExecRunner, ExecSink } from "../src/agent/capability";
import { AgentConnection, type ConnectionDeps } from "../src/agent/connection";
import { RollingLog, type LogFileSystem, type LogLevel, type Logger } from "../src/agent/log";
import { agentDataDir, agentLogPath, heartbeatPath, startupDir } from "../src/agent/platform";
import { AgentRuntime } from "../src/agent/runtime";
import type { Dialer, Scheduler, TimerHandle, Transport, TransportEvents } from "../src/agent/transport";

const V = PROTOCOL_VERSION;
const OPTS = { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES };
const enc = new TextEncoder();

// A real macrotask, which drains the whole microtask queue — every pending .then and await
// continuation — so the runtime loop settles between the deterministic time steps a test takes.
const flush = (): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, 0));

// Narrow the frames a fake transport captured to one kind, for assertions.
type Of<T extends Frame["type"]> = Extract<Frame, { type: T }>;
function pick<T extends Frame["type"]>(frames: Frame[], type: T): Of<T>[] {
  return frames.filter((f): f is Of<T> => f.type === type);
}

// --- Fakes ----------------------------------------------------------------------------------------

interface LogRecord {
  level: LogLevel;
  event: string;
  detail: Record<string, unknown>;
}

class CaptureLog implements Logger {
  readonly events: LogRecord[] = [];
  log(level: LogLevel, event: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ level, event, detail });
  }
  delays(): unknown[] {
    return this.events.filter((e) => e.event === "redial-scheduled").map((e) => e.detail.delayMs);
  }
}

// A fake transport: it decodes and keeps every frame the connection sends, and notes when closed.
class FakeTransport implements Transport {
  readonly sent: Frame[] = [];
  closed = false;
  send(text: string): void {
    const result = decodeFrame(text, OPTS);
    if (result.ok) {
      this.sent.push(result.frame);
    }
  }
  close(): void {
    this.closed = true;
  }
}

// A controllable clock and timer set. Time only moves when a test calls advance; timers due within
// the step fire in time order. Intervals re-arm, so a long advance fires a heartbeat many times.
class FakeScheduler implements Scheduler {
  time = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; interval: number | null }>();

  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn, interval: null });
    return id;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + ms, fn, interval: ms });
    return id;
  }
  clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let dueId = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === -1) {
        this.time = target;
        return;
      }
      const timer = this.timers.get(dueId)!;
      this.time = timer.at;
      if (timer.interval !== null) {
        timer.at = this.time + timer.interval;
      } else {
        this.timers.delete(dueId);
      }
      timer.fn();
    }
  }
}

// A fake dialer driven by a queue of behaviours. Each dial records when it happened; an "accept"
// hands back a fake transport and keeps the events so a test can push frames and close the socket.
class FakeDialer implements Dialer {
  readonly dials: { url: string; at: number }[] = [];
  lastTransport: FakeTransport | null = null;
  lastEvents: TransportEvents | null = null;

  constructor(
    private readonly behaviors: ("reject" | "accept")[],
    private readonly scheduler: FakeScheduler,
  ) {}

  dial(url: string, _secret: string, events: TransportEvents): Promise<Transport> {
    this.dials.push({ url, at: this.scheduler.now() });
    const behavior = this.behaviors.shift() ?? "reject";
    if (behavior === "reject") {
      return Promise.reject(new Error("connection refused"));
    }
    const transport = new FakeTransport();
    this.lastTransport = transport;
    this.lastEvents = events;
    return Promise.resolve(transport);
  }
}

class FakeRun implements ExecRun {
  canceled = 0;
  cancel(): void {
    this.canceled += 1;
  }
}

class FakeRunner implements ExecRunner {
  readonly capabilities = ["exec:powershell", "exec:wsl"] as const;
  readonly started: { request: ExecRequest; sink: ExecSink; run: FakeRun }[] = [];
  start(request: ExecRequest, sink: ExecSink): ExecRun {
    const run = new FakeRun();
    this.started.push({ request, sink, run });
    return run;
  }
}

class FakeFs implements LogFileSystem {
  readonly files = new Map<string, string>();
  size(path: string): number {
    const value = this.files.get(path);
    return value === undefined ? 0 : Buffer.byteLength(value);
  }
  append(path: string, text: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + text);
  }
  rename(from: string, to: string): void {
    const value = this.files.get(from);
    if (value !== undefined) {
      this.files.set(to, value);
      this.files.delete(from);
    }
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

// --- Connection helpers ---------------------------------------------------------------------------

interface ConnHarness {
  conn: AgentConnection;
  transport: FakeTransport;
  scheduler: FakeScheduler;
  log: CaptureLog;
}

function buildConn(overrides: Partial<ConnectionDeps> = {}): ConnHarness {
  const scheduler = new FakeScheduler();
  const transport = new FakeTransport();
  const log = new CaptureLog();
  const deps: ConnectionDeps = {
    agentName: "jake-win",
    agentVersion: "0.1.0",
    capabilities: [],
    execRunner: null,
    heartbeatMs: 1_000,
    missedHeartbeatLimit: 3,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    scheduler,
    log,
    ...overrides,
  };
  return { conn: new AgentConnection(transport, deps), transport, scheduler, log };
}

function execFrame(id: string): string {
  return encodeFrame({ type: "exec", v: V, id, shell: "powershell", command: "echo hi", cwd: null, env: {}, distro: null });
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    hubUrl: "ws://hub.example/agent",
    secret: "shared-secret",
    agentName: "jake-win",
    heartbeatMs: 100_000,
    tickMs: 60_000,
    watchdogStaleMs: 180_000,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    execMaxOutputBytes: 8 * 1024 * 1024,
    execTimeoutMs: 300_000,
    ...overrides,
  };
}

// --- Pure pieces ----------------------------------------------------------------------------------

describe("backoffDelay", () => {
  const opts = { baseMs: 100, capMs: 1_000, factor: 2 };

  test("grows exponentially and clamps to the cap", () => {
    const full = (attempt: number) => backoffDelay(attempt, opts, () => 1);
    expect(full(0)).toBe(100);
    expect(full(1)).toBe(200);
    expect(full(2)).toBe(400);
    expect(full(3)).toBe(800);
    expect(full(4)).toBe(1_000);
    expect(full(20)).toBe(1_000);
  });

  test("jitters within [0, raw]", () => {
    expect(backoffDelay(2, opts, () => 0)).toBe(0);
    expect(backoffDelay(2, opts, () => 0.5)).toBe(200);
    const sampled = backoffDelay(2, opts, () => 0.999);
    expect(sampled).toBeGreaterThanOrEqual(0);
    expect(sampled).toBeLessThanOrEqual(400);
  });
});

describe("platform paths", () => {
  test("are per-user and rendered in the platform's own separators", () => {
    const localAppData = "C:\\Users\\hass\\AppData\\Local";
    expect(agentDataDir("win32", { LOCALAPPDATA: localAppData })).toBe(`${localAppData}\\jake`);
    expect(agentLogPath("win32", { LOCALAPPDATA: localAppData })).toBe(`${localAppData}\\jake\\agent.log`);
    expect(agentDataDir("win32", { USERPROFILE: "C:\\Users\\hass" })).toBe("C:\\Users\\hass\\AppData\\Local\\jake");
    expect(agentDataDir("linux", { HOME: "/home/ahas" })).toBe("/home/ahas/.local/share/jake");
  });

  test("the heartbeat files sit beside the log, named by role", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\hass\\AppData\\Local" };
    expect(heartbeatPath("win32", env, "agent")).toBe("C:\\Users\\hass\\AppData\\Local\\jake\\agent.heartbeat");
    expect(heartbeatPath("win32", env, "guard")).toBe("C:\\Users\\hass\\AppData\\Local\\jake\\guard.heartbeat");
  });

  test("the Startup folder is the per-user one, from APPDATA or the profile fallback", () => {
    expect(startupDir({ APPDATA: "C:\\Users\\hass\\AppData\\Roaming" })).toBe(
      "C:\\Users\\hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    );
    expect(startupDir({ USERPROFILE: "C:\\Users\\hass" })).toBe(
      "C:\\Users\\hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
    );
  });
});

describe("RollingLog", () => {
  test("rotates by size and keeps a bounded number of files", () => {
    const fs = new FakeFs();
    const log = new RollingLog("/data/agent.log", { maxBytes: 150, keep: 2, fs, now: () => 0 });
    for (let i = 0; i < 20; i += 1) {
      log.log("info", "tick", { i });
    }
    expect(fs.exists("/data/agent.log")).toBe(true);
    // Never more than the live file plus `keep` rotated ones, and nothing beyond the keep window.
    expect(fs.exists("/data/agent.log.3")).toBe(false);
    expect([...fs.files.keys()].length).toBeLessThanOrEqual(3);
  });
});

// --- Connection: handshake, dispatch, heartbeat, abandonment -------------------------------------

describe("AgentConnection handshake", () => {
  test("sends a hello carrying its identity and registered capabilities", () => {
    const { conn, transport } = buildConn({ capabilities: ["exec:powershell", "exec:wsl"] });
    conn.run();
    const hello = pick(transport.sent, "hello")[0];
    expect(hello).toMatchObject({
      type: "hello",
      agent: "jake-win",
      agentVersion: "0.1.0",
      capabilities: ["exec:powershell", "exec:wsl"],
    });
  });

  test("welcome is remembered and reported in the ending outcome", async () => {
    const { conn } = buildConn();
    const done = conn.run();
    conn.handleMessage(encodeFrame({ type: "welcome", v: V, hubVersion: "9.9.9" }));
    conn.handleClose("test tore it down");
    const outcome = await done;
    expect(outcome.welcomed).toBe(true);
  });

  test("a reject ends the connection and closes the socket", async () => {
    const { conn, transport } = buildConn();
    const done = conn.run();
    conn.handleMessage(encodeFrame({ type: "reject", v: V, reason: "secret mismatch" }));
    const outcome = await done;
    expect(outcome.welcomed).toBe(false);
    expect(outcome.reason).toContain("secret mismatch");
    expect(transport.closed).toBe(true);
  });
});

describe("AgentConnection dispatch", () => {
  test("ping is answered with a pong echoing the clock", () => {
    const { conn, transport } = buildConn();
    conn.run();
    conn.handleMessage(encodeFrame({ type: "ping", v: V, ts: 4242 }));
    expect(pick(transport.sent, "pong")[0]).toMatchObject({ type: "pong", ts: 4242 });
  });

  test("exec is handed to the runner and its output streams back with sequence numbers", () => {
    const runner = new FakeRunner();
    const { conn, transport } = buildConn({ execRunner: runner, capabilities: [...runner.capabilities] });
    conn.run();
    conn.handleMessage(execFrame("c1"));

    expect(runner.started).toHaveLength(1);
    expect(runner.started[0]!.request.id).toBe("c1");

    const sink = runner.started[0]!.sink;
    sink.stdout(enc.encode("out"));
    sink.stderr(enc.encode("err"));
    sink.exit({ code: 0, signal: null, canceled: false });

    const out = pick(transport.sent, "stdout")[0]!;
    const err = pick(transport.sent, "stderr")[0]!;
    expect(out).toMatchObject({ id: "c1", seq: 0 });
    expect(err).toMatchObject({ id: "c1", seq: 1 });
    const decoded = decodeBytes(out.chunk, OPTS);
    expect(decoded.ok && new TextDecoder().decode(decoded.data)).toBe("out");
    expect(pick(transport.sent, "exit")[0]).toMatchObject({ id: "c1", code: 0, canceled: false });
  });

  test("exec with no runner registered is refused with a stated error", () => {
    const { conn, transport } = buildConn();
    conn.run();
    conn.handleMessage(execFrame("c9"));
    expect(pick(transport.sent, "error")[0]).toMatchObject({ id: "c9", code: "unsupported" });
  });

  test("cancel reaches the matching run", () => {
    const runner = new FakeRunner();
    const { conn } = buildConn({ execRunner: runner, capabilities: [...runner.capabilities] });
    conn.run();
    conn.handleMessage(execFrame("c1"));
    conn.handleMessage(encodeFrame({ type: "cancel", v: V, id: "c1" }));
    expect(runner.started[0]!.run.canceled).toBe(1);
  });

  test("a call frame is not part of the vocabulary and is refused without an answer", () => {
    const { conn, transport, log } = buildConn();
    conn.run();
    conn.handleMessage(JSON.stringify({ type: "call", v: V, id: "r1", method: "screenshot", params: null }));
    expect(transport.sent.map((frame) => frame.type)).toEqual(["hello"]);
    expect(log.events.some((entry) => entry.event === "frame-rejected")).toBe(true);
  });
});

describe("AgentConnection heartbeat", () => {
  test("pings while alive and redials after a silence past the window", async () => {
    const { conn, transport, scheduler } = buildConn({ heartbeatMs: 1_000, missedHeartbeatLimit: 3 });
    const done = conn.run();
    // Ticks at 1s, 2s, 3s each see silence <= 3s and send a ping; the tick at 4s sees 4s and ends.
    scheduler.advance(4_000);
    const outcome = await done;
    expect(pick(transport.sent, "ping")).toHaveLength(3);
    expect(outcome.reason).toContain("liveness");
    expect(transport.closed).toBe(true);
  });

  test("inbound traffic refreshes the liveness clock so a live hub is not dropped", async () => {
    const { conn, transport, scheduler } = buildConn({ heartbeatMs: 1_000, missedHeartbeatLimit: 3 });
    const done = conn.run();
    scheduler.advance(2_000); // two pings, silence at 2s
    conn.handleMessage(encodeFrame({ type: "pong", v: V, ts: 1 })); // activity at t=2000 resets it
    scheduler.advance(2_900); // t=4900, silence since 2000 is 2900 < 3000 → still alive
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(transport.closed).toBe(false);
    conn.handleClose("cleanup");
    await done;
  });
});

describe("AgentConnection abandonment on disconnect", () => {
  test("cancels every run and drops output a run pushes afterwards", async () => {
    const runner = new FakeRunner();
    const { conn, transport } = buildConn({ execRunner: runner, capabilities: [...runner.capabilities] });
    const done = conn.run();
    conn.handleMessage(execFrame("c1"));
    conn.handleMessage(execFrame("c2"));

    conn.handleClose("socket dropped");
    const outcome = await done;
    expect(outcome.reason).toContain("socket dropped");
    expect(runner.started.map((entry) => entry.run.canceled)).toEqual([1, 1]);

    // The runs report their end after the disconnect; nothing may be sent on the dead socket.
    const sentBefore = transport.sent.length;
    runner.started[0]!.sink.stdout(enc.encode("late"));
    runner.started[0]!.sink.exit({ code: null, signal: null, canceled: true });
    expect(transport.sent).toHaveLength(sentBefore);
  });
});

// --- Runtime: reconnect loop ---------------------------------------------------------------------

describe("AgentRuntime registration", () => {
  const deps = () => ({ dialer: new FakeDialer([], new FakeScheduler()), scheduler: new FakeScheduler(), log: new CaptureLog(), agentVersion: "0.1.0" });

  test("the hello list is exactly the shells the registered runner can run", () => {
    const runtime = new AgentRuntime(agentConfig(), deps());
    expect(runtime.capabilities()).toEqual([]);
    runtime.registerExec(new FakeRunner());
    expect(runtime.capabilities()).toEqual(["exec:powershell", "exec:wsl"]);
  });

  test("a second runner is refused", () => {
    const runtime = new AgentRuntime(agentConfig(), deps());
    runtime.registerExec(new FakeRunner());
    expect(() => runtime.registerExec(new FakeRunner())).toThrow("already registered");
  });
});

describe("AgentRuntime reconnect loop", () => {
  test("redials forever with a growing, capped backoff", async () => {
    const scheduler = new FakeScheduler();
    const log = new CaptureLog();
    const dialer = new FakeDialer([], scheduler); // every dial refused
    const runtime = new AgentRuntime(agentConfig(), {
      dialer,
      scheduler,
      log,
      agentVersion: "0.1.0",
      random: () => 1,
      backoff: { baseMs: 100, capMs: 400, factor: 2 },
    });

    const running = runtime.run();
    await flush(); // first dial fails, first backoff scheduled
    expect(dialer.dials).toHaveLength(1);

    for (const delay of [100, 200, 400, 400]) {
      scheduler.advance(delay);
      await flush();
    }
    expect(dialer.dials).toHaveLength(5);
    expect(log.delays()).toEqual([100, 200, 400, 400, 400]);

    runtime.stop();
    await flush();
    await running;
  });

  test("a welcomed connection that stays up resets the backoff", async () => {
    const scheduler = new FakeScheduler();
    const log = new CaptureLog();
    const dialer = new FakeDialer(["reject", "reject", "accept"], scheduler);
    const runtime = new AgentRuntime(agentConfig({ heartbeatMs: 100_000 }), {
      dialer,
      scheduler,
      log,
      agentVersion: "0.1.0",
      random: () => 1,
      backoff: { baseMs: 100, capMs: 10_000, factor: 2 },
      stableResetMs: 500,
    });

    const running = runtime.run();
    await flush(); // dial 1 refused → backoff 100
    scheduler.advance(100);
    await flush(); // dial 2 refused → backoff 200
    scheduler.advance(200);
    await flush(); // dial 3 accepted → connection live

    dialer.lastEvents!.onMessage(encodeFrame({ type: "welcome", v: V, hubVersion: "0.1.0" }));
    scheduler.advance(600); // outlasts stableResetMs, well under the 100s heartbeat window
    dialer.lastEvents!.onClose(1_000, "hub restart");
    await flush(); // loop resumes; backoff reset to base

    expect(log.delays()).toEqual([100, 200, 100]);

    runtime.stop();
    await flush();
    await running;
  });

  test("stop halts the loop and no further dials happen", async () => {
    const scheduler = new FakeScheduler();
    const log = new CaptureLog();
    const dialer = new FakeDialer([], scheduler);
    const runtime = new AgentRuntime(agentConfig(), {
      dialer,
      scheduler,
      log,
      agentVersion: "0.1.0",
      random: () => 1,
      backoff: { baseMs: 100, capMs: 400, factor: 2 },
    });

    const running = runtime.run();
    await flush();
    const dialsAtStop = dialer.dials.length;
    runtime.stop();
    await flush();
    await running;

    scheduler.advance(100_000);
    await flush();
    expect(dialer.dials).toHaveLength(dialsAtStop);
  });
});
