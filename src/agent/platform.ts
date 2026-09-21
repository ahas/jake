// Every string and choice that differs by operating system, as pure functions.

import nodePath from "node:path";

import type { ShellKind } from "../protocol";

/** The operating-system tag, as `process.platform` reports it. */
export type Platform = string;

/** A read-only view of environment variables, so the derivation takes no ambient dependency. */
export type PlatformEnv = Record<string, string | undefined>;

/**
 * The shells a host can run a command through, by platform: a Windows host offers PowerShell and WSL,
 * any other host its own Linux shell. The agent advertises only these, so the hub never offers a
 * shell the machine cannot serve. Pure, so the platform gate is exercised on either OS under test.
 */
export function execShells(platform: Platform): ShellKind[] {
  return platform === "win32" ? ["powershell", "wsl"] : ["linux"];
}

/** How the agent is kept alive on a host: the Windows self-healing pair, or a systemd user unit. */
export type PersistenceKind = "windows-pair" | "systemd-user";

/**
 * Which staying-alive scheme a host uses. Windows has no per-user, boot-capable service manager, so
 * it runs the agent/guard pair; every other host has systemd and runs the agent as a `systemd --user`
 * unit. Pure, so the selection is exercised on either OS under test.
 */
export function persistenceKind(platform: Platform): PersistenceKind {
  return platform === "win32" ? "windows-pair" : "systemd-user";
}

// Windows paths are built with the win32 flavour and POSIX paths with the posix flavour explicitly,
// rather than the host's `path`, so a Windows path comes out with backslashes even when derived on
// Linux and the result does not depend on where the derivation runs.
const win = nodePath.win32;
const posix = nodePath.posix;

/**
 * The directory the agent keeps its own data in — chiefly its rolling log. On Windows this is a
 * per-user location under LocalAppData, so it needs no elevation and survives a profile that has no
 * roaming; the profile path is the fallback when LocalAppData is unset. Off Windows the agent runs
 * only under test, so the location is a plain per-user path.
 */
export function agentDataDir(platform: Platform, env: PlatformEnv): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local !== undefined && local !== "") {
      return win.join(local, "jake");
    }
    const profile = env.USERPROFILE;
    if (profile !== undefined && profile !== "") {
      return win.join(profile, "AppData", "Local", "jake");
    }
    return win.join("C:\\", "jake");
  }

  const home = env.HOME;
  if (home !== undefined && home !== "") {
    return posix.join(home, ".local", "share", "jake");
  }
  return posix.join("/tmp", "jake");
}

/** The rolling log file the agent writes so a failure can be read afterwards without the hub. */
export function agentLogPath(platform: Platform, env: PlatformEnv): string {
  const sep = platform === "win32" ? win : posix;
  return sep.join(agentDataDir(platform, env), "agent.log");
}

/**
 * The file one process of the self-healing pair refreshes so its peer can read its liveness. Each
 * process writes its own file and reads the peer's; a timestamp older than the staleness threshold —
 * or a missing file — reads as a dead peer, so a hang is treated like a death, not only a clean exit.
 * The name is the peer key ("agent" or "guard") so the two files sit side by side under the data
 * directory.
 */
export function heartbeatPath(platform: Platform, env: PlatformEnv, name: string): string {
  const sep = platform === "win32" ? win : posix;
  return sep.join(agentDataDir(platform, env), `${name}.heartbeat`);
}

/**
 * The per-user Startup folder, where a shortcut launches its target at this user's logon. It sits
 * under the roaming AppData; APPDATA gives it directly, and the profile path plus the standard
 * relative location is the fallback when APPDATA is unset. This is always a Windows location, so it
 * is built with the win32 flavour even when derived on Linux under test.
 */
export function startupDir(env: PlatformEnv): string {
  const appData = env.APPDATA;
  const base =
    appData !== undefined && appData !== ""
      ? appData
      : win.join(env.USERPROFILE !== undefined && env.USERPROFILE !== "" ? env.USERPROFILE : "C:\\", "AppData", "Roaming");
  return win.join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/** The name of the agent's systemd user unit, as `systemctl --user` and `journalctl --user -u` use it. */
export const SYSTEMD_UNIT_NAME = "jake-agent.service";

/**
 * Where the agent's systemd user unit file is written. systemd reads user units from under the XDG
 * config home; XDG_CONFIG_HOME gives it directly, and $HOME/.config is the fallback. Always a POSIX
 * path, so it is built with the posix flavour even when derived on Windows under test.
 */
export function systemdUnitPath(env: PlatformEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome =
    xdg !== undefined && xdg !== ""
      ? xdg
      : posix.join(env.HOME !== undefined && env.HOME !== "" ? env.HOME : "/root", ".config");
  return posix.join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
}

/** Whether a systemd user unit can be managed on this host, or the reason it cannot. */
export type SystemdAvailability = { available: true } | { available: false; reason: string };

/**
 * Decide whether `systemctl --user` can supervise the agent, given whether systemd is running as this
 * system's init. A WSL distribution started without systemd has no user service manager, so a unit
 * would never run — the caller fails loudly with the returned reason rather than registering one.
 * Pure over the one fact, so the decision is exercised on any host under test.
 */
export function systemdUserAvailability(facts: { systemdAsInit: boolean }): SystemdAvailability {
  if (facts.systemdAsInit) {
    return { available: true };
  }
  return {
    available: false,
    reason:
      "systemd is not running as this system's init, so `systemctl --user` cannot supervise the agent. " +
      "On WSL, enable systemd (set `[boot] systemd=true` in /etc/wsl.conf, then run `wsl.exe --shutdown` " +
      "from Windows) and try again.",
  };
}
