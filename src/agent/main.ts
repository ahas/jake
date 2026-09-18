// The agent's run mode on 하스's Windows box. It reads the single environment file beside the
// executable, wires the real seams — a WebSocket dialer, the system clock, a rolling file log —
// registers the shell runner, the agent's only capability, and hands control to the reconnect loop,
// which dials the hub and keeps the connection alive without end. Nothing here is a credential: the hub
// URL and the shared secret come from the config file. This is one of the two run modes of the single
// executable the build produces; src/main.ts chooses between this and the guard by the command line.

import { dirname } from "node:path";

import type { AgentConfig } from "../config";
import { agentFileEnv, loadAgentConfig } from "../config";
import { JAKE_VERSION } from "../version";
import { depart } from "./departure";
import { ShellRunner, windowsSpawner } from "./exec";
import { acquireInstanceLock, diskLockFs, releaseInstanceLock, systemPidAlive } from "./instance";
import { agentDataDir, agentLogPath } from "./platform";
import { fileLogger } from "./log";
import { buildWatchdog, lockPath } from "./persistence";
import { AgentRuntime } from "./runtime";
import { systemScheduler, WebSocketDialer } from "./transport";
import { bunCommandRunner, type Watchdog } from "./watchdog";

/** This agent build's version, announced to the hub in the hello. Stamped in at compile time. */
const AGENT_VERSION = JAKE_VERSION;

export function runAgent(): void {
  const installDir = dirname(process.execPath);
  const config = loadAgentConfig(agentFileEnv(installDir));
  const log = fileLogger(agentLogPath(process.platform, process.env));

  // Wired below, once the persistence handle exists: the hub's leave frame calls this to erase the
  // agent and depart. Until then it is a no-op, and the hub sends leave only over a live connection,
  // long after startup, so the handler is always in place by the time it can fire.
  let onLeave = (): void => {};

  const runtime = new AgentRuntime(config, {
    dialer: new WebSocketDialer(),
    scheduler: systemScheduler,
    log,
    agentVersion: AGENT_VERSION,
    onLeave: () => onLeave(),
  });

  // The shell runner (exec/cancel) runs PowerShell and WSL commands through the Windows spawner,
  // holding to the configured output and time caps, and names those two shells in the hello list.
  runtime.registerExec(
    new ShellRunner({
      spawner: windowsSpawner,
      scheduler: systemScheduler,
      log,
      maxOutputBytes: config.execMaxOutputBytes,
      timeoutMs: config.execTimeoutMs,
    }),
  );

  // Staying alive is a Windows-only scheme: its anchors are Windows registrations and its watchdog
  // relaunches through the Task Scheduler. Off Windows — where the agent runs only under test — there
  // are no anchors to keep and no duplicate-launch risk, so neither the single-instance guard nor the
  // watchdog is started.
  const persistence = startPersistence(config, log);

  // The leave frame erases jake and departs. jake is a self-healing pair, so the order matters: stop
  // our own watchdog, kill the guard, remove every anchor, then hand the file deletion to a detached
  // task before exiting. departure.ts owns that order; main only supplies the real seams.
  onLeave = () =>
    depart({
      installDir,
      dataDir: agentDataDir(process.platform, process.env),
      env: process.env,
      guardLockPath: lockPath(process.platform, process.env, "guard"),
      readFile: (path) => diskLockFs().read(path),
      runner: bunCommandRunner(),
      stopSelf: () => {
        persistence?.stop();
        runtime.stop();
      },
      exit: () => process.exit(0),
      log,
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      persistence?.stop();
      runtime.stop();
      process.exit(0);
    });
  }

  log.log("info", "agent-starting", { hubUrl: config.hubUrl, agent: config.agentName, version: AGENT_VERSION });
  void runtime.run();
}

/**
 * Start the single-instance guard and the watchdog that watches the guard binary, or nothing off
 * Windows. Only one agent runs at a time — the three anchors all fire at one logon, so the first copy
 * takes the lock and the rest exit. The returned handle stops the watchdog and releases the lock on
 * a clean exit; a crash leaves the lock for the pid check to reclaim. Returns null when there is
 * nothing to start.
 */
function startPersistence(config: AgentConfig, log: ReturnType<typeof fileLogger>): { stop(): void } | null {
  if (process.platform !== "win32") {
    return null;
  }

  const lock = lockPath(process.platform, process.env, "agent");
  const lockFs = diskLockFs();
  if (!acquireInstanceLock({ path: lock, pid: process.pid, fs: lockFs, pidAlive: systemPidAlive })) {
    log.log("info", "agent-already-running", {});
    process.exit(0);
  }

  const watchdog: Watchdog = buildWatchdog("agent", {
    config,
    platform: process.platform,
    env: process.env,
    installDir: dirname(process.execPath),
    scheduler: systemScheduler,
    log,
  });
  watchdog.start();

  return {
    stop() {
      watchdog.stop();
      releaseInstanceLock(lock, lockFs);
    },
  };
}

