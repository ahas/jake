import { describe, expect, test } from "bun:test";

import {
  DEPART_TASK_NAME,
  cleanupScript,
  depart,
  departTaskCreateCommand,
  departTaskRunCommand,
  departureAnchorCommands,
  type DepartureDeps,
} from "../src/agent/departure";
import { nullLogger, type LogLevel, type Logger } from "../src/agent/log";
import type { CommandRunner } from "../src/agent/watchdog";

const INSTALL_DIR = "C:\\Users\\hass\\AppData\\Local\\Programs\\jake";
const DATA_DIR = "C:\\Users\\hass\\AppData\\Local\\jake";
const ENV = { APPDATA: "C:\\Users\\hass\\AppData\\Roaming" };
const GUARD_LOCK = "C:\\Users\\hass\\AppData\\Local\\jake\\guard.lock";

// --- Pure command construction --------------------------------------------------------------------

describe("departureAnchorCommands", () => {
  test("removes all three anchors for both the agent and the guard", () => {
    const commands = departureAnchorCommands(INSTALL_DIR, ENV);
    // Three anchors × two run modes.
    expect(commands).toHaveLength(6);

    const flat = commands.map((c) => c.join(" "));
    // Both scheduled tasks are deleted, so neither run mode returns at the next logon.
    expect(flat.some((c) => c === "schtasks /delete /tn JakeAgent /f")).toBe(true);
    expect(flat.some((c) => c === "schtasks /delete /tn JakeGuard /f")).toBe(true);
    // Both registry Run values are removed.
    expect(flat.some((c) => c.startsWith("reg delete") && c.includes("JakeAgent"))).toBe(true);
    expect(flat.some((c) => c.startsWith("reg delete") && c.includes("JakeGuard"))).toBe(true);
  });
});

describe("cleanupScript", () => {
  test("deletes the executable, both directories, and its own task", () => {
    const script = cleanupScript(INSTALL_DIR, DATA_DIR);
    expect(script).toContain(`${INSTALL_DIR}\\jake.exe`);
    expect(script).toContain(INSTALL_DIR);
    expect(script).toContain(DATA_DIR);
    // It waits for the executable to unlock before removing the folders.
    expect(script).toContain("Start-Sleep");
    // It removes itself last, so no trace of the departure task survives.
    expect(script).toContain(`schtasks /delete /tn ${DEPART_TASK_NAME} /f`);
  });
});

describe("departTaskCreateCommand", () => {
  test("registers a one-shot task that runs the cleanup through PowerShell", () => {
    const command = departTaskCreateCommand(INSTALL_DIR, DATA_DIR);
    expect(command.slice(0, 4)).toEqual(["schtasks", "/create", "/tn", DEPART_TASK_NAME]);
    const tr = command[command.indexOf("/tr") + 1]!;
    expect(tr).toContain("powershell.exe");
    expect(tr).toContain("-EncodedCommand");
  });

  test("departTaskRunCommand runs it by name", () => {
    expect(departTaskRunCommand()).toEqual(["schtasks", "/run", "/tn", DEPART_TASK_NAME]);
  });
});

// --- The orchestrator -----------------------------------------------------------------------------

// A runner that records each command it is asked to run, tagged so order across seams is legible.
class RecordingRunner implements CommandRunner {
  constructor(private readonly trace: string[]) {}
  run(command: string[]): void {
    this.trace.push(`run:${command.join(" ")}`);
  }
}

class CaptureLog implements Logger {
  readonly events: { level: LogLevel; event: string }[] = [];
  log(level: LogLevel, event: string): void {
    this.events.push({ level, event });
  }
}

function departDeps(trace: string[], overrides: Partial<DepartureDeps> = {}): DepartureDeps {
  return {
    installDir: INSTALL_DIR,
    dataDir: DATA_DIR,
    env: ENV,
    guardLockPath: GUARD_LOCK,
    readFile: (path) => (path === GUARD_LOCK ? "4321" : null),
    runner: new RecordingRunner(trace),
    stopSelf: () => trace.push("stopSelf"),
    exit: () => trace.push("exit"),
    log: nullLogger,
    ...overrides,
  };
}

describe("depart", () => {
  test("stops itself, kills the guard, removes anchors, schedules cleanup, then exits — in that order", () => {
    const trace: string[] = [];
    depart(departDeps(trace));

    // The whole ordering is what keeps the self-healing pair from undoing the leave.
    expect(trace[0]).toBe("stopSelf");
    expect(trace[trace.length - 1]).toBe("exit");

    const stopAt = trace.indexOf("stopSelf");
    const killAt = trace.findIndex((t) => t.includes("taskkill"));
    const firstAnchorAt = trace.findIndex((t) => t.includes("schtasks /delete /tn JakeAgent"));
    const createAt = trace.findIndex((t) => t.includes(`/create /tn ${DEPART_TASK_NAME}`));
    const runCleanupAt = trace.findIndex((t) => t.includes(`/run /tn ${DEPART_TASK_NAME}`));
    const exitAt = trace.indexOf("exit");

    expect(stopAt).toBeLessThan(killAt);
    expect(killAt).toBeLessThan(firstAnchorAt);
    expect(firstAnchorAt).toBeLessThan(createAt);
    expect(createAt).toBeLessThan(runCleanupAt);
    expect(runCleanupAt).toBeLessThan(exitAt);
  });

  test("kills the guard by the pid in its lock, ending the whole tree", () => {
    const trace: string[] = [];
    depart(departDeps(trace));
    expect(trace.some((t) => t === "run:taskkill /PID 4321 /T /F")).toBe(true);
  });

  test("removes every anchor for both run modes", () => {
    const trace: string[] = [];
    depart(departDeps(trace));
    const removals = trace.filter((t) => t.startsWith("run:reg delete") || t.startsWith("run:schtasks /delete /tn Jake"));
    // Three removals each for the agent and guard: the Run value, the task, and the shortcut. The
    // shortcut removal runs through PowerShell, so it is counted separately below.
    expect(trace.filter((t) => t.startsWith("run:schtasks /delete /tn JakeAgent")).length).toBe(1);
    expect(trace.filter((t) => t.startsWith("run:schtasks /delete /tn JakeGuard")).length).toBe(1);
    expect(removals.length).toBe(4); // two reg deletes + two task deletes
  });

  test("still departs when there is no guard lock to read", () => {
    const trace: string[] = [];
    depart(departDeps(trace, { readFile: () => null }));
    // No pid, so no kill command, but the leave still runs to completion and exits.
    expect(trace.some((t) => t.includes("taskkill"))).toBe(false);
    expect(trace.some((t) => t.includes(`/run /tn ${DEPART_TASK_NAME}`))).toBe(true);
    expect(trace[trace.length - 1]).toBe("exit");
  });

  test("a throwing step does not strand the ones after it, and it still exits", () => {
    const trace: string[] = [];
    const log = new CaptureLog();
    let calls = 0;
    const runner: CommandRunner = {
      run(command) {
        calls += 1;
        if (calls === 1) {
          throw new Error("taskkill failed");
        }
        trace.push(`run:${command.join(" ")}`);
      },
    };
    depart(departDeps(trace, { runner, log }));

    // The kill threw, but the anchors were still removed, the cleanup scheduled, and it exited.
    expect(trace.some((t) => t.includes(`/run /tn ${DEPART_TASK_NAME}`))).toBe(true);
    expect(trace[trace.length - 1]).toBe("exit");
    expect(log.events.some((e) => e.event === "depart-kill-guard-threw")).toBe(true);
  });
});
