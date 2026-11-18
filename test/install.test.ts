// The installers: the Linux one's answers to its three questions, and both unattended updates.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install.sh");
const WINDOWS_SCRIPT = join(import.meta.dir, "..", "scripts", "install.ps1");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Run the installer with --print-config under `script`, so its prompts read a terminal fed `input`.
async function run(args: string[], input: string): Promise<{ code: number; output: string }> {
  const home = mkdtempSync(join(tmpdir(), "jake-install-"));
  homes.push(home);
  const command = ["bash", SCRIPT, "--print-config", ...args].map((part) => `'${part}'`).join(" ");
  const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const [output, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, output: output + errors };
}

describe("install.sh prompts", () => {
  test("an empty hub URL answer takes the shown default", async () => {
    const { code, output } = await run([], "\nsekrit\nnode2\n");
    expect(code).toBe(0);
    expect(output).toContain("Hub URL [default: wss://jake.example.org]:");
    expect(output).toContain("JAKE_HUB_URL=wss://jake.example.org");
    expect(output).toContain("JAKE_AGENT_NAME=node2");
  });

  test("the shared secret has no default and an empty answer stops the install", async () => {
    const { code, output } = await run(["--hub-url", "wss://example.test"], "\n\n");
    expect(code).not.toBe(0);
    expect(output).toContain("JAKE_SECRET is required.");
  });

  test("without a terminal the hub URL still falls back to the default", async () => {
    const { code, output } = await run(["--non-interactive", "--secret", "s", "--agent-name", "n"], "");
    expect(code).toBe(0);
    expect(output).toContain("JAKE_HUB_URL=wss://jake.example.org");
  });

  test("the stream ports are taken as a list of port numbers, and anything else stops the install", async () => {
    const given = ["--non-interactive", "--secret", "s", "--agent-name", "n", "--stream-ports"];
    const listed = await run([...given, "22,2222"], "");
    expect(listed.code).toBe(0);
    expect(listed.output).toContain("JAKE_STREAM_PORTS=22,2222");
    const refused = await run([...given, "ssh"], "");
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("--stream-ports takes port numbers separated by commas, or none (got ssh)");
  });
});

// The real mv, which a stand-in falls through to.
const MV = Bun.which("mv") ?? "/bin/mv";

// An installed agent's machine in a temporary home: the previous binary and its config in place, a
// build folder holding the new binary beside a copy of the installer, and a stand-in service manager
// that records every call and, on each start, logs the agent reaching the hub where the binary in place
// says it does. Where `failMove` names a file, moving that file fails, as a swap or a rollback may.
function machine(
  previous: string,
  next: string,
  failMove?: string,
): { home: string; folder: string; bin: string; stubs: string } {
  const home = mkdtempSync(join(tmpdir(), "jake-update-"));
  homes.push(home);
  const data = join(home, ".local", "share", "jake");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "jake"), previous);
  writeFileSync(join(data, "agent.env"), "JAKE_HUB_URL=wss://example.test\nJAKE_SECRET=s\nJAKE_AGENT_NAME=n2\n");
  const folder = join(home, "build");
  mkdirSync(folder);
  copyFileSync(SCRIPT, join(folder, "install.sh"));
  writeFileSync(join(folder, "jake"), next);
  writeFileSync(join(folder, "jake-agent.service"), "[Unit]\n");
  writeFileSync(join(folder, "uninstall.sh"), "#!/bin/sh\n");
  const stubs = join(home, "stubs");
  mkdirSync(stubs);
  const systemctl = [
    "#!/bin/sh",
    `echo "$*" >> "${join(home, "systemctl.calls")}"`,
    'case " $* " in',
    '  *" enable --now "*|*" start "*)',
    `    grep -q reaches "${join(data, "jake")}" && echo '{"event":"welcomed"}' >> "${join(data, "agent.log")}" ;;`,
    "esac",
    "exit 0",
  ].join("\n");
  writeFileSync(join(stubs, "systemctl"), systemctl, { mode: 0o755 });
  writeFileSync(join(stubs, "loginctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (failMove) {
    const mv = ["#!/bin/sh", `case " $* " in *"/${failMove} "*) exit 1 ;; esac`, `exec ${MV} "$@"`].join("\n");
    writeFileSync(join(stubs, "mv"), mv, { mode: 0o755 });
  }
  return { home, folder, bin: join(data, "jake"), stubs };
}

// Whether the agent's unit runs once the install has ended: started after the last time it was stopped.
function unitRunning(at: ReturnType<typeof machine>): boolean {
  const calls = readFileSync(join(at.home, "systemctl.calls"), "utf8").split("\n");
  const last = calls.filter((call) => / (stop|start|enable --now) /.test(` ${call} `)).at(-1) ?? "";
  return !last.includes("stop");
}

async function update(at: ReturnType<typeof machine>): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bash", join(at.folder, "install.sh"), "--update"], {
    env: {
      PATH: `${at.stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: at.home,
      XDG_CONFIG_HOME: join(at.home, ".config"),
      JAKE_INSTALL_WAIT_SECONDS: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: output + errors };
}

describe("install.sh --update", () => {
  test("a new build that reaches the hub stays, and the previous one is dropped", async () => {
    const at = machine("old reaches", "new reaches");
    const { code, output } = await update(at);
    expect(output).toContain("The agent is connected to the hub.");
    expect(code).toBe(0);
    expect(readFileSync(at.bin, "utf8")).toBe("new reaches");
    expect(existsSync(`${at.bin}.previous`)).toBe(false);
  });

  test("a new build that does not reach the hub gives way to the previous one, and the update fails", async () => {
    const at = machine("old reaches", "new is silent");
    const { code, output } = await update(at);
    expect(code).not.toBe(0);
    expect(output).toContain("the update did not take; the previous build is back and connected to the hub.");
    expect(readFileSync(at.bin, "utf8")).toBe("old reaches");
    expect(existsSync(`${at.bin}.previous`)).toBe(false);
    expect(unitRunning(at)).toBe(true);
  });

  test("a swap that fails leaves the previous binary in place and the agent started again", async () => {
    const at = machine("old reaches", "new reaches", "jake.new");
    const { code, output } = await update(at);
    expect(code).not.toBe(0);
    expect(output).toContain("the install ended before it started the agent again, so it starts the agent now");
    expect(readFileSync(at.bin, "utf8")).toBe("old reaches");
    expect(unitRunning(at)).toBe(true);
  });

  test("a rollback that fails leaves the new binary in place and the agent started again", async () => {
    const at = machine("old reaches", "new is silent", "jake.previous");
    const { code, output } = await update(at);
    expect(code).not.toBe(0);
    expect(output).toContain("the update did not take, and the previous build could not be put back");
    expect(readFileSync(at.bin, "utf8")).toBe("new is silent");
    expect(unitRunning(at)).toBe(true);
  });
});

// The Windows commands install.ps1 calls, stood in for under pwsh: the registry value and the Startup
// shortcut are accepted and dropped, a registered task is recorded with its run-time limit, the jake
// processes are the tasks started and not since stopped, and starting the agent's task logs it starting
// and, where the executable in place says it does, reaching the hub. Moving the file JAKE_TEST_FAIL_MOVE
// names fails, as a swap or a rollback may while the file is held.
const WINDOWS_STAND_INS = `
$global:JakeRunning = @{ JakeAgent = $true; JakeGuard = $true }
$global:JakeRegistered = @()
function Get-Process {
  foreach ($task in @($global:JakeRunning.Keys)) {
    $process = [pscustomobject]@{ Task = $task }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) $true }
    $process
  }
}
function Stop-Process {
  param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force)
  process { $global:JakeRunning.Remove($InputObject.Task) }
}
function Move-Item {
  param($LiteralPath, $Destination)
  if ($env:JAKE_TEST_FAIL_MOVE -and (Split-Path -Leaf $LiteralPath) -eq $env:JAKE_TEST_FAIL_MOVE) { throw "$LiteralPath is in use" }
  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
function New-ItemProperty { }
function New-Item { if ("$args" -match 'HKCU:') { return }; Microsoft.PowerShell.Management\\New-Item @args }
function New-Object {
  if ("$args" -match 'ComObject') {
    $shortcut = [pscustomobject]@{ TargetPath = ''; Arguments = ''; WorkingDirectory = '' }
    $shortcut | Add-Member -MemberType ScriptMethod -Name Save -Value { }
    $shell = [pscustomobject]@{}
    $shell | Add-Member -MemberType ScriptMethod -Name CreateShortcut -Value { $shortcut }.GetNewClosure()
    return $shell
  }
  Microsoft.PowerShell.Utility\\New-Object @args
}
function New-ScheduledTaskAction { param($Execute, $Argument) @{ Argument = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn) }
function New-ScheduledTaskSettingsSet {
  param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $ExecutionTimeLimit)
  @{ ExecutionTimeLimit = $ExecutionTimeLimit }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) }
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  $global:JakeRegistered += "$TaskName limit $($Settings.ExecutionTimeLimit)"
}
function Start-ScheduledTask {
  param($TaskName)
  $global:JakeRunning[$TaskName] = $true
  if ($TaskName -ne 'JakeAgent') { return }
  $log = Join-Path $env:LOCALAPPDATA 'jake/agent.log'
  Add-Content -LiteralPath $log -Value '{"event":"agent-starting"}'
  if ((Get-Content -Raw -LiteralPath (Join-Path $env:JAKE_TEST_INSTALL 'jake.exe')) -match 'reaches') {
    Add-Content -LiteralPath $log -Value '{"event":"welcomed"}'
  }
}
`;

// A Windows machine in a temporary folder: the previous executable, its config and the log of its last
// run reaching the hub in place, and a build folder holding the new executable beside install.ps1,
// whose Startup folder is pointed at a temporary one since .NET names none on Linux.
function windowsMachine(previous: string, next: string): { install: string; build: string; localAppData: string } {
  const root = mkdtempSync(join(tmpdir(), "jake-update-win-"));
  homes.push(root);
  const localAppData = join(root, "local");
  const install = join(localAppData, "jake");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "jake.exe"), previous);
  writeFileSync(join(install, "agent.env"), "JAKE_HUB_URL=wss://example.test\nJAKE_SECRET=s\nJAKE_AGENT_NAME=u4\nJAKE_STREAM_PORTS=none\n");
  writeFileSync(join(install, "agent.log"), '{"event":"welcomed"}\n');
  const build = join(root, "build");
  mkdirSync(build);
  const startup = "[Environment]::GetFolderPath('Startup')";
  const text = readFileSync(WINDOWS_SCRIPT, "utf8");
  expect(text).toContain(startup);
  mkdirSync(join(root, "startup"));
  writeFileSync(join(build, "install.ps1"), text.replace(startup, `'${join(root, "startup")}'`));
  writeFileSync(join(build, "jake.exe"), next);
  return { install, build, localAppData };
}

type WindowsRun = { outcome: string; output: string; running: string; registered: string };

// Run install.ps1 -Update on the machine; `running` names the tasks whose process runs once it has ended.
async function windowsUpdate(at: ReturnType<typeof windowsMachine>, failMove = ""): Promise<WindowsRun> {
  const run = `${WINDOWS_STAND_INS}
try { & (Join-Path $env:JAKE_TEST_BUILD 'install.ps1') -Update -InstallDir $env:JAKE_TEST_INSTALL; 'OUTCOME: installed' }
catch { "OUTCOME: $_" }
'RUNNING: ' + (($global:JakeRunning.Keys | Sort-Object) -join ' ')
'REGISTERED: ' + ($global:JakeRegistered -join ', ')`;
  const runner = join(at.localAppData, "..", "run.ps1");
  writeFileSync(runner, run);
  const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-File", runner], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: at.localAppData,
      LOCALAPPDATA: at.localAppData,
      JAKE_TEST_BUILD: at.build,
      JAKE_TEST_INSTALL: at.install,
      JAKE_TEST_FAIL_MOVE: failMove,
      JAKE_INSTALL_WAIT_SECONDS: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = (label: string) => new RegExp(`${label}: (.*)`).exec(output)?.[1] ?? "";
  return { outcome: line("OUTCOME"), output: output + errors, running: line("RUNNING"), registered: line("REGISTERED") };
}

// Each case starts PowerShell, which takes seconds on a loaded machine.
describe("install.ps1 -Update", () => {
  test("a new executable that reaches the hub stays, the previous one is dropped, and the tasks have no run-time limit", async () => {
    const at = windowsMachine("old reaches", "new reaches");
    const { outcome, output, running, registered } = await windowsUpdate(at);
    expect(outcome).toBe("installed");
    expect(output).toContain("Installed. The agent is connected to the hub.");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("new reaches");
    expect(existsSync(join(at.install, "jake.previous.exe"))).toBe(false);
    expect(running).toBe("JakeAgent JakeGuard");
    expect(registered).toBe("JakeAgent limit 00:00:00, JakeGuard limit 00:00:00");
  }, 30_000);

  test("a new executable that never reaches the hub gives way to the previous one, though the log held an earlier welcome", async () => {
    const at = windowsMachine("old reaches", "new is silent");
    const { outcome, output, running } = await windowsUpdate(at);
    expect(output).toContain("! the new build did not reach the hub\n");
    expect(outcome).toBe("the update did not take; the previous build is back and connected to the hub.");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("old reaches");
    expect(existsSync(join(at.install, "jake.previous.exe"))).toBe(false);
    expect(running).toBe("JakeAgent JakeGuard");
  }, 30_000);

  test("a swap that fails leaves the previous executable in place and the agent and guard started again", async () => {
    const at = windowsMachine("old reaches", "new reaches");
    const { outcome, output, running } = await windowsUpdate(at, "jake.new.exe");
    expect(outcome).toStartWith("the new build could not be put in place:");
    expect(output).toContain("the install ended before it started the agent again, so it starts the agent and guard now");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("old reaches");
    expect(running).toBe("JakeAgent JakeGuard");
  }, 30_000);

  test("a rollback that fails leaves the new executable in place and the agent and guard started again", async () => {
    const at = windowsMachine("old reaches", "new is silent");
    const { outcome, running } = await windowsUpdate(at, "jake.previous.exe");
    expect(outcome).toStartWith("the update did not take, and the previous build could not be put back:");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("new is silent");
    expect(running).toBe("JakeAgent JakeGuard");
  }, 30_000);
});
