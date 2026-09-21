// The agent's departure: remove jake from the machine and exit.

import nodePath from "node:path";

import {
  anchorRemoveCommands,
  installTargets,
  taskRunCommand,
  JAKE_BINARY,
  type PlatformEnv,
} from "./anchors";
import { encodePowerShellScript, treeKillCommand } from "./exec";
import type { Logger } from "./log";
import type { CommandRunner } from "./watchdog";

/**
 * The one-shot scheduled task the detached cleanup runs under. It is created only for the departure
 * and deletes itself as its last act, so no anchor of it survives the leave.
 */
export const DEPART_TASK_NAME = "JakeDepart";

/** Quote a string as a PowerShell single-quoted literal, doubling any single quote inside it. */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The flags that make a PowerShell run unattended, ready for `-EncodedCommand`. */
function powershellInvocation(script: string): string[] {
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellScript(script),
  ];
}

/** Every command that removes all three anchors for both the agent and the guard run modes. */
export function departureAnchorCommands(installDir: string, env: PlatformEnv): string[][] {
  const { agent, guard } = installTargets(installDir);
  return [...anchorRemoveCommands(agent, env), ...anchorRemoveCommands(guard, env)];
}

/**
 * The PowerShell the detached cleanup runs. It waits for the executable to become deletable — it
 * unlocks once the pair has exited — then removes the install folder, the data directory (log,
 * heartbeats, locks), and finally the departure task itself, so nothing of jake remains. Every path
 * crosses as a single-quoted literal so spaces and quotes survive.
 */
export function cleanupScript(installDir: string, dataDir: string): string {
  const exe = nodePath.win32.join(installDir, JAKE_BINARY);
  return [
    `$exe = ${psSingleQuote(exe)}`,
    "for ($i = 0; $i -lt 100; $i++) {",
    "  if (-not (Test-Path -LiteralPath $exe)) { break }",
    "  try { Remove-Item -LiteralPath $exe -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 200 }",
    "}",
    `Remove-Item -LiteralPath ${psSingleQuote(installDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${psSingleQuote(dataDir)} -Recurse -Force -ErrorAction SilentlyContinue`,
    `schtasks /delete /tn ${DEPART_TASK_NAME} /f`,
  ].join("\n");
}

/**
 * Create the one-shot cleanup task. It is registered like the autostart anchors — per-user, no stored
 * credential, non-elevated — but its trigger never matters: it is run at once and deletes itself, so
 * the `onlogon` trigger only stands in for the schedule schtasks demands.
 */
export function departTaskCreateCommand(installDir: string, dataDir: string): string[] {
  const command = powershellInvocation(cleanupScript(installDir, dataDir)).join(" ");
  return ["schtasks", "/create", "/tn", DEPART_TASK_NAME, "/tr", command, "/sc", "onlogon", "/rl", "limited", "/f"];
}

/** Run the cleanup task now. Task Scheduler owns the process, so it outlives this one's exit. */
export function departTaskRunCommand(): string[] {
  return taskRunCommand(DEPART_TASK_NAME);
}

/** What a departure needs: where jake lives, how to reach the guard, and the seams it acts through. */
export interface DepartureDeps {
  /** The directory the executable was installed into. */
  installDir: string;
  /** The per-user data directory holding the log, heartbeats, and locks. */
  dataDir: string;
  env: PlatformEnv;
  /** The guard's single-instance lock, which holds its pid so the guard can be killed. */
  guardLockPath: string;
  /** Read a file's text, or null when it is absent. Used to read the guard's pid from its lock. */
  readFile(path: string): string | null;
  /** Runs a command, discarding its output. The same seam the watchdog rewrites anchors through. */
  runner: CommandRunner;
  /** Stop this process's own watchdog and reconnect loop before anything is torn down. */
  stopSelf(): void;
  /** End this process. Separated so the ordering can be checked without exiting the test. */
  exit(): void;
  log: Logger;
}

/**
 * Depart: erase jake and leave, in the one order that survives the self-healing pair. Each step is
 * guarded so a single failure does not strand the rest — a leave that stopped halfway would leave a
 * half-anchored agent behind, which is worse than a leave that pressed on.
 */
export function depart(deps: DepartureDeps): void {
  deps.log.log("warn", "departing", { installDir: deps.installDir, dataDir: deps.dataDir });

  // 1. Stop our own watchdog and reconnect loop, so we stop rewriting anchors and reviving the guard.
  guarded(deps, "depart-stop-self", () => deps.stopSelf());

  // 2. Kill the guard, so it stops rewriting anchors and reviving us. Its lock holds its pid.
  const pid = readPid(deps.readFile, deps.guardLockPath);
  if (pid !== null) {
    guarded(deps, "depart-kill-guard", () => deps.runner.run(treeKillCommand(pid)));
  }

  // 3. Remove every anchor for both run modes, so neither returns at the next logon.
  for (const command of departureAnchorCommands(deps.installDir, deps.env)) {
    guarded(deps, "depart-remove-anchor", () => deps.runner.run(command));
  }

  // 4. Hand the file deletion to a detached one-shot task and run it, so the executable is deleted
  //    once this process has released it.
  guarded(deps, "depart-schedule-cleanup", () => {
    deps.runner.run(departTaskCreateCommand(deps.installDir, deps.dataDir));
    deps.runner.run(departTaskRunCommand());
  });

  // 5. Leave. Releasing the executable is what lets the cleanup delete it.
  deps.exit();
}

function guarded(deps: DepartureDeps, event: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    deps.log.log("warn", `${event}-threw`, { error: error instanceof Error ? error.message : String(error) });
  }
}

function readPid(readFile: (path: string) => string | null, path: string): number | null {
  const raw = readFile(path);
  if (raw === null) {
    return null;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}
