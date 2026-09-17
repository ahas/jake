import { describe, expect, test } from "bun:test";

import { nullLogger, type Logger, type LogLevel } from "../src/agent/log";
import type { Scheduler, TimerHandle } from "../src/agent/transport";
import {
  anchorRegistrar,
  fileHeartbeat,
  peerTaskLauncher,
  Watchdog,
  type AnchorRegistrar,
  type CommandRunner,
  type Heartbeat,
  type HeartbeatFs,
  type PeerLauncher,
} from "../src/agent/watchdog";
import { installTargets } from "../src/agent/anchors";
import type { PlatformEnv } from "../src/agent/platform";

// A clock and interval driver: time only moves when the test advances it, and an interval fires each
// time its period elapses. Only the pieces the watchdog uses — now, setInterval, clearInterval — do
// anything.
class FakeScheduler implements Scheduler {
  time = 0;
  private seq = 0;
  private readonly intervals = new Map<number, { at: number; fn: () => void; period: number }>();

  now(): number {
    return this.time;
  }
  setTimeout(): TimerHandle {
    return 0;
  }
  clearTimeout(): void {}
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.intervals.set(id, { at: this.time + ms, fn, period: ms });
    return id;
  }
  clearInterval(handle: TimerHandle): void {
    this.intervals.delete(handle as number);
  }
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let dueId = -1;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.intervals) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === -1) {
        this.time = target;
        return;
      }
      const timer = this.intervals.get(dueId)!;
      this.time = timer.at;
      timer.at = this.time + timer.period;
      timer.fn();
    }
  }
}

// A heartbeat whose peer timestamp the test sets directly, recording every own-write.
class FakeHeartbeat implements Heartbeat {
  readonly writes: number[] = [];
  peer: number | null = null;
  writeOwn(nowMs: number): void {
    this.writes.push(nowMs);
  }
  readPeer(): number | null {
    return this.peer;
  }
}

class CountingRegistrar implements AnchorRegistrar {
  count = 0;
  rewriteAll(): void {
    this.count += 1;
  }
}

class CountingLauncher implements PeerLauncher {
  count = 0;
  relaunchPeer(): void {
    this.count += 1;
  }
}

class RecordingRunner implements CommandRunner {
  readonly commands: string[][] = [];
  run(command: string[]): void {
    this.commands.push(command);
  }
}

class RecordingLogger implements Logger {
  readonly lines: { level: LogLevel; event: string; detail?: Record<string, unknown> }[] = [];
  log(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    this.lines.push({ level, event, detail });
  }
}

const TICK = 60_000;
const STALE = 180_000;

function build(overrides: { heartbeat?: FakeHeartbeat; log?: Logger } = {}) {
  const scheduler = new FakeScheduler();
  const heartbeat = overrides.heartbeat ?? new FakeHeartbeat();
  const registrar = new CountingRegistrar();
  const launcher = new CountingLauncher();
  const watchdog = new Watchdog({
    heartbeat,
    registrar,
    launcher,
    scheduler,
    log: overrides.log ?? nullLogger,
    tickMs: TICK,
    staleMs: STALE,
    peerName: "JakeGuard",
  });
  return { scheduler, heartbeat, registrar, launcher, watchdog };
}

describe("Watchdog.runTick", () => {
  test("writes its own heartbeat with the current time every tick", () => {
    const { scheduler, heartbeat, watchdog } = build();
    heartbeat.peer = 0; // fresh, so no relaunch confuses the count
    scheduler.time = 1_000;
    watchdog.runTick();
    scheduler.time = 2_000;
    watchdog.runTick();
    expect(heartbeat.writes).toEqual([1_000, 2_000]);
  });

  test("rewrites all anchors every tick", () => {
    const { heartbeat, registrar, watchdog } = build();
    heartbeat.peer = 0;
    watchdog.runTick();
    watchdog.runTick();
    watchdog.runTick();
    expect(registrar.count).toBe(3);
  });

  test("relaunches the peer when its heartbeat has never been written", () => {
    const { heartbeat, launcher, watchdog } = build();
    heartbeat.peer = null;
    watchdog.runTick();
    expect(launcher.count).toBe(1);
  });

  test("relaunches the peer when its heartbeat is older than the staleness threshold", () => {
    const { scheduler, heartbeat, launcher, watchdog } = build();
    scheduler.time = 200_000;
    heartbeat.peer = 200_000 - STALE - 1; // one millisecond past stale
    watchdog.runTick();
    expect(launcher.count).toBe(1);
  });

  test("leaves a healthy peer alone", () => {
    const { scheduler, heartbeat, launcher, watchdog } = build();
    scheduler.time = 200_000;
    heartbeat.peer = 200_000 - STALE; // exactly at the threshold, not past it
    watchdog.runTick();
    heartbeat.peer = 200_000 - 1; // well within
    watchdog.runTick();
    expect(launcher.count).toBe(0);
  });

  test("logs the peer as stale before relaunching", () => {
    const log = new RecordingLogger();
    const { heartbeat, watchdog } = build({ log });
    heartbeat.peer = null;
    watchdog.runTick();
    const line = log.lines.find((l) => l.event === "peer-stale");
    expect(line).toBeDefined();
    expect(line?.detail?.peer).toBe("JakeGuard");
  });
});

describe("Watchdog.start / stop", () => {
  test("runs a tick at once and then on each interval", () => {
    const { scheduler, heartbeat, registrar, watchdog } = build();
    heartbeat.peer = 0;
    watchdog.start();
    expect(registrar.count).toBe(1); // the immediate tick
    scheduler.advance(TICK);
    expect(registrar.count).toBe(2);
    scheduler.advance(TICK * 2);
    expect(registrar.count).toBe(4);
  });

  test("stops ticking after stop", () => {
    const { scheduler, heartbeat, registrar, watchdog } = build();
    heartbeat.peer = 0;
    watchdog.start();
    const afterStart = registrar.count;
    watchdog.stop();
    scheduler.advance(TICK * 5);
    expect(registrar.count).toBe(afterStart);
  });

  test("starting twice does not double the interval", () => {
    const { scheduler, heartbeat, registrar, watchdog } = build();
    heartbeat.peer = 0;
    watchdog.start();
    watchdog.start();
    const afterStart = registrar.count;
    scheduler.advance(TICK);
    expect(registrar.count).toBe(afterStart + 1);
  });
});

// --- The real seams, driven by fakes -------------------------------------------------------------

class FakeHeartbeatFs implements HeartbeatFs {
  readonly files = new Map<string, string>();
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  write(path: string, text: string): void {
    this.files.set(path, text);
  }
}

describe("fileHeartbeat", () => {
  test("writes the timestamp to its own file and reads the peer's", () => {
    const fs = new FakeHeartbeatFs();
    const hb = fileHeartbeat("/data/agent.heartbeat", "/data/guard.heartbeat", fs);
    hb.writeOwn(1_700_000_000_000);
    expect(fs.files.get("/data/agent.heartbeat")).toBe("1700000000000");
    fs.files.set("/data/guard.heartbeat", "1699999999000");
    expect(hb.readPeer()).toBe(1699999999000);
  });

  test("reads a missing peer file as null", () => {
    const hb = fileHeartbeat("/data/agent.heartbeat", "/data/guard.heartbeat", new FakeHeartbeatFs());
    expect(hb.readPeer()).toBeNull();
  });

  test("reads a garbled peer file as null", () => {
    const fs = new FakeHeartbeatFs();
    fs.files.set("/data/guard.heartbeat", "not-a-number");
    const hb = fileHeartbeat("/data/agent.heartbeat", "/data/guard.heartbeat", fs);
    expect(hb.readPeer()).toBeNull();
  });
});

describe("anchorRegistrar", () => {
  test("runs all three register commands for every target on a rewrite", () => {
    const runner = new RecordingRunner();
    const env: PlatformEnv = { APPDATA: "C:\\Users\\Hass\\AppData\\Roaming" };
    const { agent, guard } = installTargets("C:\\jake");
    anchorRegistrar([agent, guard], env, runner).rewriteAll();
    expect(runner.commands).toHaveLength(6); // three anchors × two targets
    const heads = runner.commands.map((c) => c[0]);
    expect(heads).toEqual(["reg", "schtasks", "powershell.exe", "reg", "schtasks", "powershell.exe"]);
  });
});

describe("peerTaskLauncher", () => {
  test("relaunches the peer by running its scheduled task", () => {
    const runner = new RecordingRunner();
    peerTaskLauncher("JakeAgent", runner).relaunchPeer();
    expect(runner.commands).toEqual([["schtasks", "/run", "/tn", "JakeAgent"]]);
  });
});
