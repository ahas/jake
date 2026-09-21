// The Linux staying-alive teardown and its one system probe.

import { existsSync } from "node:fs";

import type { Logger } from "./log";
import { SYSTEMD_UNIT_NAME } from "./platform";
import type { CommandRunner } from "./watchdog";

/** The transient unit the detached leave teardown runs under, so stopping the agent unit cannot kill it. */
export const DEPART_UNIT_NAME = "jake-depart";

/** Whether systemd is running as this system's init — the fact `systemdUserAvailability` decides on. */
export function systemdRunsAsInit(): boolean {
  return existsSync("/run/systemd/system");
}

/** Quote a string as one POSIX shell word, so a path with spaces or quotes crosses `sh -c` intact. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The shell the detached teardown runs: stop and disable the agent's unit so nothing restarts it,
 * remove the unit file, have systemd forget it, and delete the agent's whole per-user tree — the
 * binary, its config, and its log all sit under the one directory.
 */
export function linuxCleanupScript(unitPath: string, dataDir: string): string {
  return [
    `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
    `rm -f ${shQuote(unitPath)}`,
    "systemctl --user daemon-reload",
    `rm -rf ${shQuote(dataDir)}`,
  ].join("\n");
}

/**
 * The command that runs the cleanup detached from the agent's own unit. `systemd-run --user` starts it
 * as a separate transient unit, so disabling and stopping the agent unit does not kill the teardown
 * and the deletion outlives the agent's exit — the Linux counterpart of the Windows one-shot task.
 */
export function linuxDepartCommand(unitPath: string, dataDir: string): string[] {
  return [
    "systemd-run",
    "--user",
    "--collect",
    "--unit",
    DEPART_UNIT_NAME,
    "/bin/sh",
    "-c",
    linuxCleanupScript(unitPath, dataDir),
  ];
}

/** What a Linux departure needs: where the unit and data live, the command seam, and the stop/exit hooks. */
export interface LinuxDepartureDeps {
  /** The agent's systemd user unit file. */
  unitPath: string;
  /** The per-user directory holding the binary, its config, and its log. */
  dataDir: string;
  /** Runs a command, discarding its output. The same seam the Windows leave acts through. */
  runner: CommandRunner;
  /** Stop this process's own reconnect loop before the teardown is handed off. */
  stopSelf(): void;
  /** End this process. Separated so the ordering can be checked without exiting the test. */
  exit(): void;
  log: Logger;
}

/**
 * Depart on a Linux host: stop this process's own work, hand the unit teardown and file deletion to a
 * detached transient unit, and exit. Each step is guarded so one failure does not strand the rest.
 */
export function departLinux(deps: LinuxDepartureDeps): void {
  deps.log.log("warn", "departing", { dataDir: deps.dataDir });
  guarded(deps.log, "depart-stop-self", () => deps.stopSelf());
  guarded(deps.log, "depart-teardown", () => deps.runner.run(linuxDepartCommand(deps.unitPath, deps.dataDir)));
  deps.exit();
}

function guarded(log: Logger, event: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    log.log("warn", `${event}-threw`, { error: error instanceof Error ? error.message : String(error) });
  }
}
