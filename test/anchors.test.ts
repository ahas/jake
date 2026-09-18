import { describe, expect, test } from "bun:test";

import {
  AGENT_ANCHOR_NAME,
  GUARD_ANCHOR_NAME,
  GUARD_MODE_FLAG,
  JAKE_BINARY,
  anchorRegisterCommands,
  anchorRemoveCommands,
  installTargets,
  runKeyAddCommand,
  runKeyRemoveCommand,
  startupShortcutCreateCommand,
  startupShortcutPath,
  startupShortcutRemoveCommand,
  taskCreateCommand,
  taskRemoveCommand,
  taskRunCommand,
  type AnchorTarget,
} from "../src/agent/anchors";
import type { PlatformEnv } from "../src/agent/platform";

const AGENT: AnchorTarget = { name: AGENT_ANCHOR_NAME, binaryPath: "C:\\Program Files\\jake\\jake.exe", args: [] };
const GUARD: AnchorTarget = {
  name: GUARD_ANCHOR_NAME,
  binaryPath: "C:\\Program Files\\jake\\jake.exe",
  args: [GUARD_MODE_FLAG],
};
const ENV: PlatformEnv = { APPDATA: "C:\\Users\\Hass\\AppData\\Roaming" };

/** Decode the UTF-16LE base64 a `-EncodedCommand` carries back into the PowerShell script it wraps. */
function decodeEncodedCommand(command: string[]): string {
  const index = command.indexOf("-EncodedCommand");
  expect(index).toBeGreaterThan(-1);
  const encoded = command[index + 1];
  expect(encoded).toBeDefined();
  return Buffer.from(encoded as string, "base64").toString("utf16le");
}

describe("installTargets", () => {
  test("anchors both run modes to the one executable", () => {
    const { agent, guard } = installTargets("C:\\Program Files\\jake");
    expect(agent.name).toBe(AGENT_ANCHOR_NAME);
    expect(agent.binaryPath).toBe(`C:\\Program Files\\jake\\${JAKE_BINARY}`);
    expect(agent.args).toEqual([]);
    expect(guard.name).toBe(GUARD_ANCHOR_NAME);
    expect(guard.binaryPath).toBe(`C:\\Program Files\\jake\\${JAKE_BINARY}`);
    expect(guard.args).toEqual([GUARD_MODE_FLAG]);
  });

  test("the two run modes share the executable but hold distinct anchors", () => {
    const { agent, guard } = installTargets("C:\\Program Files\\jake");
    expect(agent.binaryPath).toBe(guard.binaryPath);
    expect(AGENT_ANCHOR_NAME).not.toBe(GUARD_ANCHOR_NAME);
    // The guard run mode is told apart by the flag; the agent carries none.
    expect(guard.args).toContain(GUARD_MODE_FLAG);
    expect(agent.args).toHaveLength(0);
  });
});

describe("registry Run anchor", () => {
  test("adds a per-user Run value with the quoted executable path", () => {
    expect(runKeyAddCommand(AGENT)).toEqual([
      "reg",
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "JakeAgent",
      "/t",
      "REG_SZ",
      "/d",
      '"C:\\Program Files\\jake\\jake.exe"',
      "/f",
    ]);
  });

  test("carries the guard flag after the quoted path for the guard run mode", () => {
    const command = runKeyAddCommand(GUARD);
    const data = command[command.indexOf("/d") + 1];
    expect(data).toBe('"C:\\Program Files\\jake\\jake.exe" --guard');
  });

  test("removes the same value it added", () => {
    expect(runKeyRemoveCommand(AGENT)).toEqual([
      "reg",
      "delete",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "JakeAgent",
      "/f",
    ]);
  });
});

describe("scheduled-task anchor", () => {
  test("creates a self-owned, non-elevated logon task with the guard flag", () => {
    const command = taskCreateCommand(GUARD);
    expect(command).toEqual([
      "schtasks",
      "/create",
      "/tn",
      "JakeGuard",
      "/tr",
      '"C:\\Program Files\\jake\\jake.exe" --guard',
      "/sc",
      "onlogon",
      "/rl",
      "limited",
      "/f",
    ]);
    // No credential flags: /ru and /rp would store an account, and /sc onstart would need one.
    expect(command).not.toContain("/ru");
    expect(command).not.toContain("/rp");
    expect(command).not.toContain("onstart");
  });

  test("runs the agent task with a bare quoted path", () => {
    const command = taskCreateCommand(AGENT);
    expect(command[command.indexOf("/tr") + 1]).toBe('"C:\\Program Files\\jake\\jake.exe"');
  });

  test("removes the task by name", () => {
    expect(taskRemoveCommand(GUARD)).toEqual(["schtasks", "/delete", "/tn", "JakeGuard", "/f"]);
  });

  test("runs a task by name for a relaunch", () => {
    expect(taskRunCommand("JakeAgent")).toEqual(["schtasks", "/run", "/tn", "JakeAgent"]);
  });
});

describe("Startup-folder shortcut anchor", () => {
  test("locates the shortcut in the per-user Startup folder", () => {
    expect(startupShortcutPath(AGENT, ENV)).toBe(
      "C:\\Users\\Hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\JakeAgent.lnk",
    );
  });

  test("falls back to the profile path when APPDATA is unset", () => {
    const path = startupShortcutPath(AGENT, { USERPROFILE: "C:\\Users\\Hass" });
    expect(path).toBe(
      "C:\\Users\\Hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\JakeAgent.lnk",
    );
  });

  test("builds the agent shortcut through WScript.Shell with no arguments", () => {
    const script = decodeEncodedCommand(startupShortcutCreateCommand(AGENT, ENV));
    expect(script).toContain("WScript.Shell");
    expect(script).toContain(
      "'C:\\Users\\Hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\JakeAgent.lnk'",
    );
    expect(script).toContain("$s.TargetPath = 'C:\\Program Files\\jake\\jake.exe'");
    expect(script).toContain("$s.WorkingDirectory = 'C:\\Program Files\\jake'");
    expect(script).not.toContain("$s.Arguments");
    expect(script).toContain("$s.Save()");
  });

  test("builds the guard shortcut with the guard flag as its arguments", () => {
    const script = decodeEncodedCommand(startupShortcutCreateCommand(GUARD, ENV));
    expect(script).toContain("$s.TargetPath = 'C:\\Program Files\\jake\\jake.exe'");
    expect(script).toContain("$s.Arguments = '--guard'");
  });

  test("escapes a single quote in a path so the literal stays closed", () => {
    const tricky: AnchorTarget = { name: "JakeAgent", binaryPath: "C:\\o'brien\\jake.exe", args: [] };
    const script = decodeEncodedCommand(startupShortcutCreateCommand(tricky, ENV));
    expect(script).toContain("$s.TargetPath = 'C:\\o''brien\\jake.exe'");
  });

  test("removes the shortcut by its literal path", () => {
    const script = decodeEncodedCommand(startupShortcutRemoveCommand(AGENT, ENV));
    expect(script).toContain("Remove-Item -LiteralPath");
    expect(script).toContain(
      "'C:\\Users\\Hass\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\JakeAgent.lnk'",
    );
    expect(script).toContain("-Force");
  });
});

describe("whole-target command sets", () => {
  test("registration runs all three anchors for a target", () => {
    const commands = anchorRegisterCommands(AGENT, ENV);
    expect(commands).toHaveLength(3);
    expect(commands[0]?.[0]).toBe("reg");
    expect(commands[1]?.[0]).toBe("schtasks");
    expect(commands[2]?.[0]).toBe("powershell.exe");
  });

  test("removal covers all three anchors for a target", () => {
    const commands = anchorRemoveCommands(AGENT, ENV);
    expect(commands).toHaveLength(3);
    expect(commands[0]?.slice(0, 2)).toEqual(["reg", "delete"]);
    expect(commands[1]?.slice(0, 2)).toEqual(["schtasks", "/delete"]);
    expect(commands[2]?.[0]).toBe("powershell.exe");
  });
});
