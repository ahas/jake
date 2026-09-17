// Every string that differs by operating system is produced here, by a pure function of the
// platform name and an environment record, so it can be exercised on Linux even though it names
// Windows locations. The agent runs on 하스's Windows box; these tests run on main-host. Keeping the
// derivation pure is what lets the two coexist. docs/architecture.md is the canonical statement of
// where the agent keeps its own files.

import nodePath from "node:path";

/** The operating-system tag, as `process.platform` reports it. */
export type Platform = string;

/** A read-only view of environment variables, so the derivation takes no ambient dependency. */
export type PlatformEnv = Record<string, string | undefined>;

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
