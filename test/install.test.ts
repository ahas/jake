// The installers: the Linux one's answers to its three questions, and both unattended updates.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishAgents } from "../scripts/publish-agents";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install.sh");
const WINDOWS_SCRIPT = join(import.meta.dir, "..", "scripts", "install.ps1");
const homes: string[] = [];

// A folder holding the files given, removed after the test like a home.
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jake-build-"));
  homes.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// The hub a published copy names, as a deployment's publish step writes it in.
const PUBLISHED_HUB = "wss://hub.example.test";

// Run the installer with --print-config under `script`, so its prompts read a terminal fed `input`: the
// repository's own copy, which no deployment published, or a published one naming `PUBLISHED_HUB`.
async function run(args: string[], input: string, published = true): Promise<{ code: number; output: string }> {
  const home = mkdtempSync(join(tmpdir(), "jake-install-"));
  homes.push(home);
  let script = SCRIPT;
  if (published) {
    const from = folder({ "install.sh": readFileSync(SCRIPT, "utf8"), "version.txt": "0.1.0+gtest\n" });
    script = join(home, "published");
    mkdirSync(script);
    publishAgents(from, script, { downloadUrl: "https://downloads.example.test/jake", hubUrl: PUBLISHED_HUB });
    script = join(script, "install.sh");
  }
  const command = ["bash", script, "--print-config", ...args].map((part) => `'${part}'`).join(" ");
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
  test("an empty hub URL answer takes the hub the publishing deployment wrote in", async () => {
    const { code, output } = await run([], "\nsekrit\nnode2\n");
    expect(code).toBe(0);
    expect(output).toContain(`Hub URL [default: ${PUBLISHED_HUB}]:`);
    expect(output).toContain(`JAKE_HUB_URL=${PUBLISHED_HUB}`);
    expect(output).toContain("JAKE_AGENT_NAME=node2");
  });

  test("a copy no deployment published offers no hub, and an empty answer stops the install", async () => {
    const { code, output } = await run([], "\n", false);
    expect(code).not.toBe(0);
    expect(output).toContain("Hub URL: ");
    expect(output).not.toContain("default:");
    expect(output).toContain("JAKE_HUB_URL is required.");
  });

  test("the shared secret has no default and an empty answer stops the install", async () => {
    const { code, output } = await run(["--hub-url", "wss://example.test"], "\n\n");
    expect(code).not.toBe(0);
    expect(output).toContain("JAKE_SECRET is required.");
  });

  test("without a terminal the hub URL still falls back to the published one, and to none in a copy never published", async () => {
    const given = ["--non-interactive", "--secret", "s", "--agent-name", "n"];
    const published = await run(given, "");
    expect(published.code).toBe(0);
    expect(published.output).toContain(`JAKE_HUB_URL=${PUBLISHED_HUB}`);
    const unpublished = await run(given, "", false);
    expect(unpublished.code).not.toBe(0);
    expect(unpublished.output).toContain("JAKE_HUB_URL was not provided");
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
      JAKE_WINDOWS_USERS: join(at.home, "windows", "users"),
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
// shortcut are accepted and dropped, a registered task is recorded with its triggers, its run-time limit
// and its restarts, the jake
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
function New-ScheduledTaskTrigger {
  param([switch]$AtLogOn, [switch]$Once, $At, $RepetitionInterval, $RepetitionDuration)
  if ($AtLogOn) { return 'at logon' }
  if ($null -ne $RepetitionDuration) { return "every $RepetitionInterval for $RepetitionDuration" }
  "every $RepetitionInterval"
}
function New-ScheduledTaskSettingsSet {
  param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $ExecutionTimeLimit, $RestartCount, $RestartInterval)
  @{ ExecutionTimeLimit = $ExecutionTimeLimit; RestartCount = $RestartCount; RestartInterval = $RestartInterval }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) }
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  $global:JakeRegistered += "$TaskName $($Trigger -join ' and ') limit $($Settings.ExecutionTimeLimit) restart $($Settings.RestartCount) after $($Settings.RestartInterval)"
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
  test("a new executable that reaches the hub stays, the previous one is dropped, and the tasks repeat and restart with no run-time limit", async () => {
    const at = windowsMachine("old reaches", "new reaches");
    const { outcome, output, running, registered } = await windowsUpdate(at);
    expect(outcome).toBe("installed");
    expect(output).toContain("Installed. The agent is connected to the hub.");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("new reaches");
    expect(existsSync(join(at.install, "jake.previous.exe"))).toBe(false);
    expect(running).toBe("JakeAgent JakeGuard");
    const task = "at logon and every 00:05:00 limit 00:00:00 restart 3 after 00:01:00";
    expect(registered).toBe(`JakeAgent ${task}, JakeGuard ${task}`);
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

// The Windows side a WSL install reaches through interop, stood in for: powershell.exe runs the script
// it is handed under pwsh behind stand-ins that record each task registered and started, writing to
// standard error as Windows PowerShell does when its streams are redirected, and refusing an S4U task
// where JAKE_TEST_REFUSE is set, or every task where it is all; wslpath turns a Windows path's backslashes into slashes,
// which PowerShell on Linux also reads as separators.
const WSL_STAND_INS = `
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User, [switch]$Once, $At, $RepetitionInterval) }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $ExecutionTimeLimit, $RestartCount, $RestartInterval, $MultipleInstances) }
function New-ScheduledTaskAction { param($Execute, $Argument) "$Execute $Argument" }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) "$LogonType" }
function Register-ScheduledTask {
  param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
  [Console]::Error.WriteLine('#< CLIXML')
  if ($env:JAKE_TEST_REFUSE -eq 'all' -or ($Principal -eq 'S4U' -and $env:JAKE_TEST_REFUSE)) { throw 'Access is denied.' }
  Add-Content -LiteralPath $env:JAKE_TEST_TASKS -Value "registered $TaskName as $Principal running $Action"
}
function Get-ScheduledTask { [CmdletBinding()] param($TaskName) $TaskName }
function Start-ScheduledTask { [CmdletBinding()] param($TaskName) Add-Content -LiteralPath $env:JAKE_TEST_TASKS -Value "started $TaskName" }
function Stop-ScheduledTask { [CmdletBinding()] param($TaskName) Add-Content -LiteralPath $env:JAKE_TEST_TASKS -Value "stopped $TaskName" }
function Unregister-ScheduledTask { param($TaskName, $Confirm) Add-Content -LiteralPath $env:JAKE_TEST_TASKS -Value "unregistered $TaskName" }
`;

// A WSL machine: the installed machine above with the Windows executable in its build folder, and the
// stand-ins for interop where `interop` is set.
function wslMachine(interop: boolean): ReturnType<typeof machine> & { localAppData: string; tasks: string } {
  const at = machine("old reaches", "new reaches");
  writeFileSync(join(at.folder, "jake.exe"), "the windows build");
  const localAppData = join(at.home, "windows", "local");
  mkdirSync(localAppData, { recursive: true });
  const tasks = join(at.home, "windows", "tasks");
  writeFileSync(tasks, "");
  if (interop) {
    writeFileSync(join(at.home, "windows", "stand-ins.ps1"), WSL_STAND_INS);
    const powershell = [
      "#!/bin/sh",
      'while [ "$1" != -EncodedCommand ]; do shift; done',
      `script="${join(at.home, "windows", "script.ps1")}"`,
      `cat "${join(at.home, "windows", "stand-ins.ps1")}" > "$script"`,
      'printf %s "$2" | base64 -d | iconv -f UTF-16LE -t UTF-8 >> "$script"',
      'exec pwsh -NoProfile -NonInteractive -File "$script"',
    ].join("\n");
    writeFileSync(join(at.stubs, "powershell.exe"), powershell, { mode: 0o755 });
    writeFileSync(join(at.stubs, "wslpath"), "#!/bin/sh\nprintf '%s\\n' \"$2\" | tr '\\\\' /\n", { mode: 0o755 });
  }
  return { ...at, localAppData, tasks };
}

async function runOnWsl(
  at: ReturnType<typeof wslMachine>,
  script: string[],
  refuse = "",
): Promise<{ code: number; output: string }> {
  mkdirSync(join(at.home, "windows", "users"), { recursive: true });
  const proc = Bun.spawn(["bash", ...script], {
    env: {
      PATH: `${at.stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: at.home,
      XDG_CONFIG_HOME: join(at.home, ".config"),
      JAKE_INSTALL_WAIT_SECONDS: "0",
      WSL_DISTRO_NAME: "Ubuntu-24.04",
      LOCALAPPDATA: at.localAppData,
      JAKE_TEST_TASKS: at.tasks,
      JAKE_TEST_REFUSE: refuse,
      JAKE_WINDOWS_USERS: join(at.home, "windows", "users"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output: output + errors };
}

const install = (at: ReturnType<typeof wslMachine>, refuse = "") =>
  runOnWsl(at, [join(at.folder, "install.sh"), "--non-interactive"], refuse);

// Each case that reaches Windows starts PowerShell, which takes seconds on a loaded machine.
describe("install.sh on WSL", () => {
  test("registers and starts a task that holds the distribution with no password stored", async () => {
    const at = wslMachine(true);
    const { code, output } = await install(at);
    expect(output).toContain("registered: it holds Ubuntu-24.04 from boot, whether or not you are logged on");
    expect(code).toBe(0);
    expect(readFileSync(at.tasks, "utf8")).toBe(
      'registered JakeWsl-Ubuntu-24.04 as S4U running wsl.exe -d Ubuntu-24.04 --exec sleep infinity\nstarted JakeWsl-Ubuntu-24.04\n',
    );
  }, 30_000);

  test("where Windows refuses that task, places the Windows executable and has it hold the distribution from logon", async () => {
    const at = wslMachine(true);
    const { code, output } = await install(at, "s4u");
    expect(output).toContain("from your logon only, since Windows refused a task that runs without it: Access is denied.");
    expect(code).toBe(0);
    const launcher = join(at.localAppData, "Programs", "jake-wsl", "JakeWsl-Ubuntu-24.04", "jake.exe");
    expect(readFileSync(launcher, "utf8")).toBe("the windows build");
    const registered = readFileSync(at.tasks, "utf8").split("\n")[0];
    expect(registered).toStartWith("registered JakeWsl-Ubuntu-24.04 as Interactive running ");
    expect(registered).toEndWith("jake.exe --hold-wsl Ubuntu-24.04");
  }, 30_000);

  test("where Windows refuses every task, says why and still installs", async () => {
    const at = wslMachine(true);
    const { code, output } = await install(at, "all");
    expect(output).toContain("the task could not be registered: Access is denied.");
    expect(code).toBe(0);
    expect(readFileSync(at.tasks, "utf8")).toBe("");
  }, 30_000);

  test("without interop, leaves the task as it is and still installs", async () => {
    const at = wslMachine(false);
    const { code, output } = await install(at);
    expect(output).toContain("Windows interop is not reachable from here, so the task is left as it is.");
    expect(code).toBe(0);
  });

  test("the uninstall stops and removes the task", async () => {
    const at = wslMachine(true);
    copyFileSync(join(import.meta.dir, "..", "scripts", "uninstall.sh"), join(at.folder, "uninstall.sh"));
    const { code } = await runOnWsl(at, [join(at.folder, "uninstall.sh")]);
    expect(code).toBe(0);
    expect(readFileSync(at.tasks, "utf8")).toBe("stopped JakeWsl-Ubuntu-24.04\nunregistered JakeWsl-Ubuntu-24.04\n");
  }, 30_000);
});

// A Windows install of the same PC, as a WSL distribution sees it through /mnt/c: its executable, its agent.env
// naming `name`, and an uninstall.ps1 that records the folder it was asked to remove.
function windowsInstall(at: ReturnType<typeof wslMachine>, name: string): { dir: string; removed: string } {
  const dir = join(at.home, "windows", "users", "person", "AppData", "Local", "Programs", "jake");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jake.exe"), "the windows build");
  writeFileSync(join(dir, "agent.env"), `JAKE_HUB_URL=wss://example.test\nJAKE_SECRET=s\nJAKE_AGENT_NAME=${name}\n`);
  const removed = join(at.home, "windows", "removed");
  writeFileSync(join(dir, "uninstall.ps1"), `param($InstallDir)\nSet-Content -LiteralPath '${removed}' -Value "removed $InstallDir"\n`);
  return { dir, removed };
}

// Whether the install stopped the agent's unit at any point.
function unitStopped(at: ReturnType<typeof machine>): boolean {
  const calls = join(at.home, "systemctl.calls");
  return existsSync(calls) && readFileSync(calls, "utf8").includes("stop");
}

describe("install.sh: one jake per machine", () => {
  test("beside a Windows install of the same PC, refuses naming it and the two ways on, and changes nothing", async () => {
    const at = wslMachine(false);
    windowsInstall(at, "u63");
    const { code, output } = await install(at);
    expect(code).not.toBe(0);
    expect(output).toContain("a Windows install in");
    expect(output).toContain("another jake already serves this machine as u63");
    expect(output).toContain("bind your account to u63 as a shared node");
    expect(output).toContain("--replace");
    expect(readFileSync(at.bin, "utf8")).toBe("old reaches");
    expect(existsSync(`${at.bin}.new`)).toBe(false);
    expect(unitStopped(at)).toBe(false);
  });

  test("with --replace, runs the Windows install's own uninstaller first and then installs", async () => {
    const at = wslMachine(true);
    const windows = windowsInstall(at, "u63");
    const { code, output } = await runOnWsl(at, [join(at.folder, "install.sh"), "--non-interactive", "--replace"]);
    expect(output).toContain("removing u63 through its own uninstaller");
    expect(code).toBe(0);
    expect(readFileSync(windows.removed, "utf8").trim()).toBe(`removed ${windows.dir}`);
    expect(readFileSync(at.bin, "utf8")).toBe("new reaches");
  }, 60_000);

  test("an agent of another name the hub says holds this machine refuses the install, and one out of reach refuses --replace too", async () => {
    const at = wslMachine(false);
    writeFileSync(
      join(at.folder, "jake"),
      "#!/bin/sh\n# reaches\necho machine=0123456789abcdef0123456789abcdef\necho hub=answered\necho held-by=jake-other\n",
    );
    const refused = await install(at);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("an agent the hub says holds this machine: jake-other");
    expect(refused.output).toContain("another jake already serves this machine as jake-other");

    const replacing = await runOnWsl(at, [join(at.folder, "install.sh"), "--non-interactive", "--replace"]);
    expect(replacing.code).not.toBe(0);
    expect(replacing.output).toContain("jake-other holds this machine from where this install cannot reach it");
    expect(unitStopped(at)).toBe(false);
  });

  test("the hub naming this install itself, by its name now or before, refuses nothing", async () => {
    const at = wslMachine(false);
    writeFileSync(join(at.folder, "jake"), "#!/bin/sh\n# reaches\necho hub=answered\necho held-by=n2\n");
    const { code, output } = await install(at);
    expect(output).toContain("none found");
    expect(code).toBe(0);
  });

  test("an update looks at none of it", async () => {
    const at = wslMachine(false);
    windowsInstall(at, "u63");
    const { code } = await runOnWsl(at, [join(at.folder, "install.sh"), "--update"]);
    expect(code).toBe(0);
    expect(readFileSync(at.bin, "utf8")).toBe("new reaches");
  });

  test("a listen port another program holds refuses the install, naming the port", async () => {
    const at = wslMachine(false);
    const env = join(at.home, ".local", "share", "jake", "agent.env");
    writeFileSync(env, `${readFileSync(env, "utf8")}JAKE_LISTEN_PORTS=4100\n`);
    writeFileSync(
      join(at.stubs, "ss"),
      `#!/bin/sh\necho 'LISTEN 0 4096 127.0.0.1:4100 0.0.0.0:* users:(("node",pid=4242,fd=20))'\n`,
      { mode: 0o755 },
    );
    const { code, output } = await install(at);
    expect(code).not.toBe(0);
    expect(output).toContain("port 4100 is already held on this machine by node");
    expect(unitStopped(at)).toBe(false);
  });
});

describe("install.ps1: one jake per machine", () => {
  test("beside a WSL install of the same PC, refuses naming it, and changes nothing", async () => {
    const at = windowsMachine("old reaches", "new reaches");
    const run = `${WINDOWS_STAND_INS}
function wsl.exe { 'distribution=Ubuntu-24.04'; 'jake=jake-wsl'; 'listen=22 sshd' }
try { & (Join-Path $env:JAKE_TEST_BUILD 'install.ps1') -HubUrl wss://example.test -Secret s -AgentName u63 -NonInteractive -InstallDir $env:JAKE_TEST_INSTALL; 'OUTCOME: installed' }
catch { "OUTCOME: $_" }
'RUNNING: ' + (($global:JakeRunning.Keys | Sort-Object) -join ' ')`;
    const runner = join(at.localAppData, "..", "run-refused.ps1");
    writeFileSync(runner, run);
    const proc = Bun.spawn(["pwsh", "-NoProfile", "-NonInteractive", "-File", runner], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: at.localAppData,
        LOCALAPPDATA: at.localAppData,
        JAKE_TEST_BUILD: at.build,
        JAKE_TEST_INSTALL: at.install,
        JAKE_INSTALL_WAIT_SECONDS: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(output).toContain("a WSL install in Ubuntu-24.04: jake-wsl");
    expect(output).toContain("OUTCOME: another jake already serves this machine as jake-wsl");
    expect(output).toContain("-Replace");
    expect(output).toContain("RUNNING: JakeAgent JakeGuard");
    expect(readFileSync(join(at.install, "jake.exe"), "utf8")).toBe("old reaches");
    expect(existsSync(join(at.install, "jake.new.exe"))).toBe(false);
  }, 30_000);
});
