// The guard's run mode on 하스's Windows box: the small supervisor half of the self-healing pair. It
// carries no tunnel and no capability handlers — its whole job is to watch the agent by its
// heartbeat, rewrite the autostart anchors, and relaunch the agent when it goes stale. It runs from
// the same executable as the agent, chosen by the guard-mode flag on the command line, and is a
// separate process that watches the agent and is watched back, so either can bring the other back.
// It reads the same environment file the agent does, laid down beside the executable by the
// installer. docs/architecture.md is the canonical statement of the staying-alive scheme.

import { dirname } from "node:path";

import { agentFileEnv, loadAgentConfig } from "../config";
import { JAKE_VERSION } from "../version";
import { agentLogPath } from "../agent/platform";
import { fileLogger } from "../agent/log";
import { acquireInstanceLock, diskLockFs, releaseInstanceLock, systemPidAlive } from "../agent/instance";
import { buildWatchdog, lockPath } from "../agent/persistence";
import { systemScheduler } from "../agent/transport";

export function runGuard(): void {
  const config = loadAgentConfig(agentFileEnv(dirname(process.execPath)));
  const log = fileLogger(agentLogPath(process.platform, process.env));

  // Only one guard runs at a time. The three anchors all fire at logon, so without this a single
  // logon would start three guards; the first takes the lock and the rest exit.
  const lock = lockPath(process.platform, process.env, "guard");
  const lockFs = diskLockFs();
  if (!acquireInstanceLock({ path: lock, pid: process.pid, fs: lockFs, pidAlive: systemPidAlive })) {
    log.log("info", "guard-already-running", {});
    process.exit(0);
  }

  const watchdog = buildWatchdog("guard", {
    config,
    platform: process.platform,
    env: process.env,
    installDir: dirname(process.execPath),
    scheduler: systemScheduler,
    log,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      watchdog.stop();
      releaseInstanceLock(lock, lockFs);
      process.exit(0);
    });
  }

  log.log("info", "guard-starting", { installDir: dirname(process.execPath), version: JAKE_VERSION });
  watchdog.start();
}
