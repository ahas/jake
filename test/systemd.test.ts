import { describe, expect, test } from "bun:test";

import { nullLogger, type LogLevel, type Logger } from "../src/agent/log";
import {
  persistenceKind,
  SYSTEMD_UNIT_NAME,
  systemdUnitPath,
  systemdUserAvailability,
} from "../src/agent/platform";
import {
  DEPART_UNIT_NAME,
  departLinux,
  linuxCleanupScript,
  linuxDepartCommand,
  type LinuxDepartureDeps,
} from "../src/agent/systemd";
import type { CommandRunner } from "../src/agent/watchdog";

// --- Platform selection ---------------------------------------------------------------------------

describe("persistenceKind", () => {
  test("Windows runs the self-healing pair", () => {
    expect(persistenceKind("win32")).toBe("windows-pair");
  });

  test("every other host runs a systemd user unit", () => {
    expect(persistenceKind("linux")).toBe("systemd-user");
    expect(persistenceKind("darwin")).toBe("systemd-user");
  });
});

describe("systemdUnitPath", () => {
  test("writes under XDG_CONFIG_HOME when it is set", () => {
    expect(systemdUnitPath({ XDG_CONFIG_HOME: "/home/hass/.config", HOME: "/home/hass" })).toBe(
      "/home/hass/.config/systemd/user/jake-agent.service",
    );
  });

  test("falls back to HOME/.config when XDG_CONFIG_HOME is unset", () => {
    expect(systemdUnitPath({ HOME: "/home/hass" })).toBe("/home/hass/.config/systemd/user/jake-agent.service");
  });

  test("the unit basename is the name systemctl and journalctl use", () => {
    expect(systemdUnitPath({ HOME: "/home/hass" }).endsWith(`/${SYSTEMD_UNIT_NAME}`)).toBe(true);
  });
});

// --- The systemd-unavailable detection ------------------------------------------------------------

describe("systemdUserAvailability", () => {
  test("is available when systemd is the init", () => {
    expect(systemdUserAvailability({ systemdAsInit: true })).toEqual({ available: true });
  });

  test("is unavailable with a clear WSL reason when systemd is not the init", () => {
    const verdict = systemdUserAvailability({ systemdAsInit: false });
    expect(verdict.available).toBe(false);
    if (!verdict.available) {
      // The reason names the failing tool and the one host step that fixes it, so an install fails
      // loudly rather than registering a unit that never runs.
      expect(verdict.reason).toContain("systemctl --user");
      expect(verdict.reason).toContain("wsl.conf");
    }
  });
});

// --- Pure command construction for the leave teardown ---------------------------------------------

const UNIT = "/home/hass/.config/systemd/user/jake-agent.service";
const DATA = "/home/hass/.local/share/jake";

describe("linuxCleanupScript", () => {
  test("stops and disables the unit, removes it, reloads, and deletes the tree", () => {
    const script = linuxCleanupScript(UNIT, DATA);
    expect(script).toContain(`systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`);
    expect(script).toContain(`rm -f '${UNIT}'`);
    expect(script).toContain("systemctl --user daemon-reload");
    expect(script).toContain(`rm -rf '${DATA}'`);
  });

  test("single-quotes a path so a quote in it survives the shell", () => {
    const script = linuxCleanupScript(UNIT, "/home/o'brien/jake");
    expect(script).toContain("'/home/o'\\''brien/jake'");
  });
});

describe("linuxDepartCommand", () => {
  test("runs the cleanup detached under its own transient unit", () => {
    const command = linuxDepartCommand(UNIT, DATA);
    expect(command.slice(0, 5)).toEqual(["systemd-run", "--user", "--collect", "--unit", DEPART_UNIT_NAME]);
    expect(command).toContain("/bin/sh");
    expect(command[command.length - 1]).toBe(linuxCleanupScript(UNIT, DATA));
  });
});

// --- The orchestrator -----------------------------------------------------------------------------

class RecordingRunner implements CommandRunner {
  constructor(private readonly trace: string[]) {}
  run(command: string[]): void {
    this.trace.push(`run:${command[0]}`);
  }
}

class CaptureLog implements Logger {
  readonly events: { level: LogLevel; event: string }[] = [];
  log(level: LogLevel, event: string): void {
    this.events.push({ level, event });
  }
}

function linuxDeps(trace: string[], overrides: Partial<LinuxDepartureDeps> = {}): LinuxDepartureDeps {
  return {
    unitPath: UNIT,
    dataDir: DATA,
    runner: new RecordingRunner(trace),
    stopSelf: () => trace.push("stopSelf"),
    exit: () => trace.push("exit"),
    log: nullLogger,
    ...overrides,
  };
}

describe("departLinux", () => {
  test("stops itself, hands the teardown to systemd-run, then exits — in that order", () => {
    const trace: string[] = [];
    departLinux(linuxDeps(trace));
    expect(trace).toEqual(["stopSelf", "run:systemd-run", "exit"]);
  });

  test("a throwing teardown does not strand the exit", () => {
    const trace: string[] = [];
    const log = new CaptureLog();
    const runner: CommandRunner = {
      run() {
        throw new Error("systemd-run failed");
      },
    };
    departLinux(linuxDeps(trace, { runner, log }));
    expect(trace[trace.length - 1]).toBe("exit");
    expect(log.events.some((e) => e.event === "depart-teardown-threw")).toBe(true);
  });
});
