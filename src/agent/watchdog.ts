// The self-healing watchdog. This is the part that answers "꺼지지 않아야 한다". Each binary of the
// pair runs one Watchdog against its peer: on a fixed tick it refreshes its own heartbeat, rewrites
// every autostart anchor, and — finding the peer's heartbeat stale past a threshold — relaunches it.
// Liveness is judged by the heartbeat a peer refreshes rather than by its exit alone, so a hung peer
// that never exited is still treated as dead and brought back.
//
// The decision — write, rewrite, and (only if the peer is stale) relaunch — is the whole of the
// logic worth testing, so the store, the anchor registrar, the peer launcher, and the clock are all
// seams. On this machine a fake clock, a fake heartbeat store, and a fake launcher drive every case;
// the real seams at the bottom of this file are the only place a disk or a spawned process is
// touched. docs/architecture.md is the canonical statement of the staying-alive scheme.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { anchorRegisterCommands, taskRunCommand, type AnchorTarget, type PlatformEnv } from "./anchors";
import type { Logger } from "./log";
import type { Scheduler, TimerHandle } from "./transport";

/** The heartbeat a process refreshes for its peer to read. Each side writes its own, reads the peer's. */
export interface Heartbeat {
  /** Record that this process is alive as of `nowMs`. */
  writeOwn(nowMs: number): void;
  /** The peer's last recorded timestamp, or null when it has never written or its file is unreadable. */
  readPeer(): number | null;
}

/** Rewrites all autostart anchors. The watchdog calls it once per tick so a wiped anchor is repaired. */
export interface AnchorRegistrar {
  rewriteAll(): void;
}

/** Relaunches the peer. The real launcher runs the peer's scheduled task, so the peer is not a child. */
export interface PeerLauncher {
  relaunchPeer(): void;
}

/** What the watchdog needs: its three seams, a clock, a log, and the two intervals. */
export interface WatchdogOptions {
  heartbeat: Heartbeat;
  registrar: AnchorRegistrar;
  launcher: PeerLauncher;
  scheduler: Scheduler;
  log: Logger;
  /** How often, in milliseconds, the watchdog refreshes its heartbeat and rewrites the anchors. */
  tickMs: number;
  /** A peer whose last heartbeat is older than this, in milliseconds, is treated as dead. */
  staleMs: number;
  /** The peer's name, for the log line when it is relaunched. */
  peerName: string;
}

/**
 * One process's watchdog over its peer. `start` runs a tick at once — so the first heartbeat and the
 * anchors are in place immediately — and then on each `tickMs`. A tick refreshes the heartbeat,
 * rewrites every anchor, and relaunches the peer only when the peer's heartbeat is missing or stale.
 * A redundant relaunch is harmless: the peer's own single-instance guard drops a second copy, so the
 * watchdog does not need to remember that it already asked.
 */
export class Watchdog {
  private readonly opts: WatchdogOptions;
  private timer: TimerHandle | null = null;

  constructor(options: WatchdogOptions) {
    this.opts = options;
  }

  /** Begin ticking: one tick now, then one every `tickMs`. */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.runTick();
    this.timer = this.opts.scheduler.setInterval(() => this.runTick(), this.opts.tickMs);
  }

  /** Stop ticking. The heartbeat and anchors are left as they stand. */
  stop(): void {
    if (this.timer !== null) {
      this.opts.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One cycle. Public so the decision can be driven directly by a test's fake clock. */
  runTick(): void {
    const now = this.opts.scheduler.now();
    this.opts.heartbeat.writeOwn(now);
    this.opts.registrar.rewriteAll();

    const peerTs = this.opts.heartbeat.readPeer();
    if (peerTs === null || now - peerTs > this.opts.staleMs) {
      this.opts.log.log("warn", "peer-stale", {
        peer: this.opts.peerName,
        lastSeenMs: peerTs,
        ageMs: peerTs === null ? null : now - peerTs,
      });
      this.opts.launcher.relaunchPeer();
    }
  }
}

// --- Real seams ----------------------------------------------------------------------------------

/** The narrow filesystem the heartbeat store needs, injected so its parsing is checked without a disk. */
export interface HeartbeatFs {
  /** The text of a file, or null if it does not exist or cannot be read. */
  read(path: string): string | null;
  /** Write text to a file, creating any missing parent directory. */
  write(path: string, text: string): void;
}

/** The real filesystem for the heartbeat store, used on 하스's box. */
export function diskHeartbeatFs(): HeartbeatFs {
  return {
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
  };
}

/**
 * A heartbeat backed by two files: this process writes `ownPath`, and reads the peer's `peerPath`.
 * The timestamp is stored as the plain epoch-millisecond integer; a file that is missing or does not
 * parse reads as null, which the watchdog treats as a dead peer.
 */
export function fileHeartbeat(ownPath: string, peerPath: string, fs: HeartbeatFs): Heartbeat {
  return {
    writeOwn(nowMs) {
      fs.write(ownPath, String(nowMs));
    },
    readPeer() {
      const raw = fs.read(peerPath);
      if (raw === null) {
        return null;
      }
      const value = Number.parseInt(raw.trim(), 10);
      return Number.isNaN(value) ? null : value;
    },
  };
}

/** Runs one command, discarding its output. Injected so the registrar and launcher are checked here. */
export interface CommandRunner {
  run(command: string[]): void;
}

/**
 * The real command runner on 하스's box. It spawns each command detached from the tunnel's own work,
 * discarding stdout and stderr — reg, schtasks, and the shortcut's PowerShell are quick and their
 * output is not needed. It never awaits, so rewriting the anchors never stalls the connection the
 * agent is holding.
 */
export function bunCommandRunner(): CommandRunner {
  return {
    run(command) {
      const [file, ...args] = command;
      if (file === undefined) {
        return;
      }
      try {
        Bun.spawn([file, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      } catch {
        // A failed spawn of one anchor command must not stop the tick; the next tick tries again.
      }
    },
  };
}

/**
 * The registrar that rewrites every anchor for every target on each tick. It runs the register
 * commands the anchors module builds, so which commands run is what the anchor tests cover and this
 * only sequences them.
 */
export function anchorRegistrar(targets: AnchorTarget[], env: PlatformEnv, runner: CommandRunner): AnchorRegistrar {
  return {
    rewriteAll() {
      for (const target of targets) {
        for (const command of anchorRegisterCommands(target, env)) {
          runner.run(command);
        }
      }
    },
  };
}

/**
 * The launcher that relaunches the peer by running its scheduled task. The Task Scheduler service
 * starts the peer on this process's behalf, so the relaunched peer is not this process's child and
 * shares no teardown boundary with it — the independence the pair needs to survive a common-cause
 * kill. The task is rewritten every tick, so it is present to be run.
 */
export function peerTaskLauncher(peerName: string, runner: CommandRunner): PeerLauncher {
  return {
    relaunchPeer() {
      runner.run(taskRunCommand(peerName));
    },
  };
}
