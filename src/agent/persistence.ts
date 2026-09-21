// Wiring for the Windows staying-alive scheme, shared by the two binaries.

import type { AgentConfig } from "../config";
import {
  AGENT_ANCHOR_NAME,
  GUARD_ANCHOR_NAME,
  installTargets,
  type PlatformEnv,
  type Platform,
} from "./anchors";
import { agentDataDir, heartbeatPath } from "./platform";
import type { Logger } from "./log";
import type { Scheduler } from "./transport";
import {
  anchorRegistrar,
  bunCommandRunner,
  diskHeartbeatFs,
  fileHeartbeat,
  peerTaskLauncher,
  Watchdog,
} from "./watchdog";
import nodePath from "node:path";

/** Which binary of the pair this process is. */
export type PairRole = "agent" | "guard";

/** The single-instance lock file for one role, beside the heartbeats under the data directory. */
export function lockPath(platform: Platform, env: PlatformEnv, role: PairRole): string {
  const sep = platform === "win32" ? nodePath.win32 : nodePath.posix;
  return sep.join(agentDataDir(platform, env), `${role}.lock`);
}

/** What building the watchdog needs beyond the config: the platform, the install directory, the seams. */
export interface PersistenceDeps {
  config: AgentConfig;
  platform: Platform;
  env: PlatformEnv;
  /** The directory the executable was installed into — where the anchors point. */
  installDir: string;
  scheduler: Scheduler;
  log: Logger;
}

/**
 * Build this process's watchdog. It refreshes this role's heartbeat, reads the peer's, rewrites the
 * anchors for both binaries, and relaunches the peer's scheduled task when the peer goes stale. The
 * caller starts and stops it.
 */
export function buildWatchdog(role: PairRole, deps: PersistenceDeps): Watchdog {
  const peerRole: PairRole = role === "agent" ? "guard" : "agent";
  const peerAnchorName = role === "agent" ? GUARD_ANCHOR_NAME : AGENT_ANCHOR_NAME;
  const { agent, guard } = installTargets(deps.installDir);
  const runner = bunCommandRunner();

  const heartbeat = fileHeartbeat(
    heartbeatPath(deps.platform, deps.env, role),
    heartbeatPath(deps.platform, deps.env, peerRole),
    diskHeartbeatFs(),
  );

  return new Watchdog({
    heartbeat,
    registrar: anchorRegistrar([agent, guard], deps.env, runner),
    launcher: peerTaskLauncher(peerAnchorName, runner),
    scheduler: deps.scheduler,
    log: deps.log,
    tickMs: deps.config.tickMs,
    staleMs: deps.config.watchdogStaleMs,
    peerName: peerAnchorName,
  });
}
