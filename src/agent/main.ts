// The agent run mode: wires the real seams and runs the reconnect loop.

import { dirname } from "node:path";

import type { AgentConfig } from "../config";
import { agentFileEnv, loadAgentConfig } from "../config";
import { JAKE_VERSION } from "../version";
import { depart } from "./departure";
import { buildLinuxInvocation, buildWindowsInvocation, linuxSpawner, ShellRunner, windowsSpawner } from "./exec";
import { FileTransferRunner, nodeTransferFs } from "./transfer";
import { acquireInstanceLock, diskLockFs, releaseInstanceLock, systemPidAlive } from "./instance";
import {
  agentDataDir,
  agentLogPath,
  execShells,
  persistenceKind,
  systemdUnitPath,
  systemdUserAvailability,
} from "./platform";
import { fileLogger } from "./log";
import { buildWatchdog, lockPath } from "./persistence";
import { AgentRuntime } from "./runtime";
import { departLinux, systemdRunsAsInit } from "./systemd";
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

  // The shell runner (exec/cancel) runs the host's shells, holding to the configured output and time
  // caps, and names in the hello list only the shells this platform can serve. Which spawner, command
  // construction, and shell set are used follows the platform: PowerShell and WSL through the Windows
  // spawner on Windows, a Linux shell through the Linux spawner otherwise.
  const onWindows = process.platform === "win32";
  runtime.registerExec(
    new ShellRunner({
      spawner: onWindows ? windowsSpawner : linuxSpawner,
      scheduler: systemScheduler,
      log,
      maxOutputBytes: config.execMaxOutputBytes,
      timeoutMs: config.execTimeoutMs,
      shells: execShells(process.platform),
      buildInvocation: onWindows ? buildWindowsInvocation : buildLinuxInvocation,
    }),
  );

  // The file-transfer runner moves files over the tunnel's own frames, in both directions, so no
  // scp-style path is needed to reach a machine that only dials outward. It writes an upload to a
  // temp file and moves it into place atomically once its bytes verify.
  runtime.registerTransfer(
    new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: config.maxPayloadBytes, log }),
  );

  // Staying alive depends on the host. On Windows it is the self-healing pair — the anchors plus a
  // watchdog that relaunches the peer through the Task Scheduler. On Linux systemd is the supervisor,
  // so nothing runs here beyond a check that systemd is in fact the init.
  const persistence = startPersistence(config, log);

  // The leave frame erases jake and departs, in the one order that survives the host's staying-alive
  // scheme: on Windows stop the watchdog, kill the guard, remove the anchors, then hand file deletion
  // to a detached task; on Linux hand the unit teardown and the deletion to a detached systemd-run.
  // Each path owns its order; main only supplies the real seams.
  const stopSelf = () => {
    persistence?.stop();
    runtime.stop();
  };
  onLeave = () => {
    if (persistenceKind(process.platform) === "windows-pair") {
      depart({
        installDir,
        dataDir: agentDataDir(process.platform, process.env),
        env: process.env,
        guardLockPath: lockPath(process.platform, process.env, "guard"),
        readFile: (path) => diskLockFs().read(path),
        runner: bunCommandRunner(),
        stopSelf,
        exit: () => process.exit(0),
        log,
      });
      return;
    }
    departLinux({
      unitPath: systemdUnitPath(process.env),
      dataDir: agentDataDir(process.platform, process.env),
      runner: bunCommandRunner(),
      stopSelf,
      exit: () => process.exit(0),
      log,
    });
  };

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
 * Start what keeps the agent alive on this host. On Windows that is the single-instance guard and the
 * watchdog: only one agent runs at a time — the three anchors all fire at one logon, so the first copy
 * takes the lock and the rest exit — and the returned handle stops the watchdog and releases the lock
 * on a clean exit, while a crash leaves the lock for the pid check to reclaim. On Linux systemd is the
 * supervisor and there is nothing to start; a direct run where systemd is not the init has no
 * supervisor at all, so that is said plainly in the log rather than left to look supervised. Returns
 * null when there is nothing to run.
 */
function startPersistence(config: AgentConfig, log: ReturnType<typeof fileLogger>): { stop(): void } | null {
  if (persistenceKind(process.platform) === "systemd-user") {
    const availability = systemdUserAvailability({ systemdAsInit: systemdRunsAsInit() });
    if (!availability.available) {
      log.log("warn", "no-persistence", { reason: availability.reason });
    }
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

