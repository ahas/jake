// The guard run mode: the supervisor half of the Windows self-healing pair.

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
