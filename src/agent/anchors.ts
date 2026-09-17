// The three autostart anchors, built as pure command and value construction so they can be checked
// without a Windows machine. All three are per-user and need no elevation: a value under the
// per-user registry Run key, a shortcut in the per-user Startup folder, and a scheduled task with a
// logon trigger and no stored credentials. A running process rewrites every anchor on each watchdog
// tick, so the wipe of any one is repaired within a tick as long as either process of the pair is
// alive. docs/architecture.md is the canonical statement of the staying-alive scheme.
//
// The consequence of staying per-user is stated there and holds here: every anchor fires at this
// user's interactive logon, never at raw boot, because a boot-time or run-whether-logged-on-or-not
// registration would need an administrator account the install may not have. Recovery after a kill
// that ends both processes is therefore bound to the next interactive logon.

import nodePath from "node:path";

import { encodePowerShellScript } from "./exec";
import { startupDir, type Platform, type PlatformEnv } from "./platform";

// The two binaries of the self-healing pair. They are different programs with different names — and
// so different hashes — on purpose: a single `taskkill /IM`, one antivirus signature on a running
// image, or one job-object teardown then cannot end both at once. jake-agent carries the tunnel and
// every capability; jake-guard is the small supervisor that carries none, so the two differ in
// crash surface and attack surface as well as in name.
export const AGENT_BINARY = "jake-agent.exe";
export const GUARD_BINARY = "jake-guard.exe";

// The stable identifiers each binary is anchored under. One name serves as the registry value name,
// the scheduled-task name, and the Startup shortcut's base name, so an anchor of any kind is found,
// rewritten, and removed by the same key.
export const AGENT_ANCHOR_NAME = "JakeAgent";
export const GUARD_ANCHOR_NAME = "JakeGuard";

// The per-user Run key. HKCU needs no elevation to write, and its values are launched by explorer at
// this user's logon.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** One binary to anchor: the identifier it is registered under, and the executable an anchor starts. */
export interface AnchorTarget {
  /** The registry value name, task name, and shortcut base name this binary is anchored under. */
  name: string;
  /** The absolute path to the executable the anchor launches. */
  binaryPath: string;
}

/** The two anchor targets for an install laid out in one directory: the agent and the guard exes. */
export function installTargets(dir: string): { agent: AnchorTarget; guard: AnchorTarget } {
  return {
    agent: { name: AGENT_ANCHOR_NAME, binaryPath: nodePath.win32.join(dir, AGENT_BINARY) },
    guard: { name: GUARD_ANCHOR_NAME, binaryPath: nodePath.win32.join(dir, GUARD_BINARY) },
  };
}

/** Quote a string as a PowerShell single-quoted literal, doubling any single quote inside it. */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The flags that make a PowerShell run unattended: no profile, no prompt, and policy bypassed. */
function powershellCommand(script: string): string[] {
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

// --- Registry Run key ----------------------------------------------------------------------------

/**
 * Add (or overwrite, with `/f`) the per-user Run value that launches this binary at logon. The data
 * is the binary path wrapped in quotes so a path with spaces is launched as one argument.
 */
export function runKeyAddCommand(target: AnchorTarget): string[] {
  return ["reg", "add", RUN_KEY, "/v", target.name, "/t", "REG_SZ", "/d", `"${target.binaryPath}"`, "/f"];
}

/** Remove this binary's per-user Run value. */
export function runKeyRemoveCommand(target: AnchorTarget): string[] {
  return ["reg", "delete", RUN_KEY, "/v", target.name, "/f"];
}

// --- Scheduled task ------------------------------------------------------------------------------

/**
 * Create (or overwrite, with `/f`) a scheduled task that runs this binary at the user's logon. It is
 * self-owned — no `/ru`/`/rp`, so no credential is stored and no elevation is needed to register it —
 * and `/rl limited` runs it non-elevated. `/sc onlogon` is deliberate: `/sc onstart` and
 * "run whether the user is logged on or not" would each need an administrator account the install
 * may not have, so recovery is bound to the next interactive logon, not to boot.
 */
export function taskCreateCommand(target: AnchorTarget): string[] {
  return [
    "schtasks",
    "/create",
    "/tn",
    target.name,
    "/tr",
    `"${target.binaryPath}"`,
    "/sc",
    "onlogon",
    "/rl",
    "limited",
    "/f",
  ];
}

/** Delete this binary's scheduled task. */
export function taskRemoveCommand(target: AnchorTarget): string[] {
  return ["schtasks", "/delete", "/tn", target.name, "/f"];
}

/**
 * Run an already-registered task now. This is how a live process relaunches its stale peer: the Task
 * Scheduler service starts the peer on the caller's behalf, so the relaunched peer is not the
 * caller's child and shares no teardown boundary with it — exactly the independence the pair needs to
 * survive a common-cause kill.
 */
export function taskRunCommand(name: string): string[] {
  return ["schtasks", "/run", "/tn", name];
}

// --- Startup-folder shortcut ---------------------------------------------------------------------

/** The full path to this binary's shortcut in the per-user Startup folder. */
export function startupShortcutPath(target: AnchorTarget, env: PlatformEnv): string {
  return nodePath.win32.join(startupDir(env), `${target.name}.lnk`);
}

/**
 * Create (or overwrite) the Startup-folder shortcut that launches this binary at logon. A `.lnk`
 * cannot be written as plain bytes; it is built through the WScript.Shell COM object from a short
 * PowerShell script, whose path and target literals are single-quoted so a path with spaces or
 * quotes crosses intact.
 */
export function startupShortcutCreateCommand(target: AnchorTarget, env: PlatformEnv): string[] {
  const lnk = startupShortcutPath(target, env);
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psSingleQuote(lnk)})`,
    `$s.TargetPath = ${psSingleQuote(target.binaryPath)}`,
    `$s.WorkingDirectory = ${psSingleQuote(nodePath.win32.dirname(target.binaryPath))}`,
    "$s.Save()",
  ].join("\n");
  return powershellCommand(script);
}

/** Remove this binary's Startup-folder shortcut. Absence is not an error. */
export function startupShortcutRemoveCommand(target: AnchorTarget, env: PlatformEnv): string[] {
  const lnk = startupShortcutPath(target, env);
  return powershellCommand(`Remove-Item -LiteralPath ${psSingleQuote(lnk)} -Force -ErrorAction SilentlyContinue`);
}

// --- Whole-target command sets -------------------------------------------------------------------

/** Every command that registers all three anchors for one binary, in the order a rewrite runs them. */
export function anchorRegisterCommands(target: AnchorTarget, env: PlatformEnv): string[][] {
  return [runKeyAddCommand(target), taskCreateCommand(target), startupShortcutCreateCommand(target, env)];
}

/** Every command that removes all three anchors for one binary. */
export function anchorRemoveCommands(target: AnchorTarget, env: PlatformEnv): string[][] {
  return [runKeyRemoveCommand(target), taskRemoveCommand(target), startupShortcutRemoveCommand(target, env)];
}

/** Re-export the platform types the anchor callers pass, so a caller needs only this module. */
export type { Platform, PlatformEnv };
