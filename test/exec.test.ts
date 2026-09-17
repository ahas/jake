import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecRequest, ExecSink } from "../src/agent/capability";
import {
  buildWindowsInvocation,
  buildPowerShellInvocation,
  buildWslInvocation,
  encodePowerShellScript,
  execCapability,
  ShellRunner,
  treeKillCommand,
  type Invocation,
  type Spawner,
} from "../src/agent/exec";
import { nullLogger } from "../src/agent/log";
import { systemScheduler } from "../src/agent/transport";

// --- A request builder and a capturing sink -------------------------------------------------------

function request(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    id: "run-1",
    shell: "powershell",
    command: "echo hi",
    cwd: null,
    env: {},
    distro: null,
    ...overrides,
  };
}

// Records everything the runner streams, in the order it arrives, and resolves `done` at the one end
// (an exit or a fail). It counts raw bytes per stream so the output cap can be asserted precisely,
// and fires `onFirst` at the first stdout chunk so a test can prove output arrived before the exit.
class CaptureSink implements ExecSink {
  readonly chunks: { stream: "stdout" | "stderr"; text: string; bytes: number }[] = [];
  exitOutcome: { code: number | null; signal: string | null; canceled: boolean } | null = null;
  failure: { code: string; message: string } | null = null;
  onFirst: (() => void) | null = null;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly decoder = new TextDecoder();

  constructor() {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }
  stdout(chunk: Uint8Array): void {
    if (this.chunks.length === 0) {
      this.onFirst?.();
    }
    this.chunks.push({ stream: "stdout", text: this.decoder.decode(chunk), bytes: chunk.byteLength });
  }
  stderr(chunk: Uint8Array): void {
    this.chunks.push({ stream: "stderr", text: this.decoder.decode(chunk), bytes: chunk.byteLength });
  }
  exit(outcome: { code: number | null; signal: string | null; canceled: boolean }): void {
    this.exitOutcome = outcome;
    this.resolveDone();
  }
  fail(code: string, message: string): void {
    this.failure = { code, message };
    this.resolveDone();
  }
  text(stream?: "stdout" | "stderr"): string {
    return this.chunks.filter((c) => stream === undefined || c.stream === stream).map((c) => c.text).join("");
  }
  byteCount(stream: "stdout" | "stderr"): number {
    return this.chunks.filter((c) => c.stream === stream).reduce((n, c) => n + c.bytes, 0);
  }
}

// --- A real POSIX spawner, standing in for the Windows shells ------------------------------------

// The command is launched under `setsid`, which makes it a new process-group leader, so killing the
// negative pid ends the whole tree — the same guarantee `taskkill /T` gives on Windows. This is what
// lets the cancel/cap/timeout tests prove a grandchild dies, not only the immediate child.
const posixSpawner: Spawner = {
  spawn(invocation) {
    const proc = Bun.spawn(["setsid", invocation.file, ...invocation.args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: invocation.cwd ?? undefined,
      env: { ...process.env, ...invocation.env },
    });
    return {
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      exited: proc.exited.then(() => ({ code: proc.exitCode, signal: proc.signalCode })),
      killTree() {
        if (proc.pid === undefined) {
          return;
        }
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // already gone
        }
      },
    };
  },
};

// Maps a request onto a POSIX shell, so the runner's streaming logic is exercised without Windows.
const posixBuild = (req: ExecRequest): Invocation => ({
  file: "sh",
  args: ["-c", req.command],
  cwd: req.cwd,
  env: req.env,
});

function posixRunner(overrides: { maxOutputBytes?: number; timeoutMs?: number } = {}): ShellRunner {
  return new ShellRunner({
    spawner: posixSpawner,
    scheduler: systemScheduler,
    log: nullLogger,
    maxOutputBytes: overrides.maxOutputBytes ?? 1024 * 1024,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    buildInvocation: posixBuild,
  });
}

// --- Command-line construction (pure) ------------------------------------------------------------

describe("buildWindowsInvocation — PowerShell", () => {
  test("carries the non-interactive, no-profile, bypass flags", () => {
    const inv = buildPowerShellInvocation(request({ command: "Get-Date" }));
    expect(inv.file).toBe("powershell.exe");
    expect(inv.args).toContain("-NoProfile");
    expect(inv.args).toContain("-NonInteractive");
    const policyAt = inv.args.indexOf("-ExecutionPolicy");
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(inv.args[policyAt + 1]).toBe("Bypass");
  });

  test("the encoded command decodes back to the UTF-8 prelude followed by the command", () => {
    const inv = buildPowerShellInvocation(request({ command: "Write-Output 안녕" }));
    const encodedAt = inv.args.indexOf("-EncodedCommand");
    const script = Buffer.from(inv.args[encodedAt + 1]!, "base64").toString("utf16le");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
    expect(script.endsWith("Write-Output 안녕")).toBe(true);
  });

  test("round-trips a command with quotes and newlines untouched", () => {
    const command = 'Write-Output "a\nb"; $x = 3';
    expect(encodePowerShellScript(command)).toBe(Buffer.from(command, "utf16le").toString("base64"));
  });

  test("passes cwd and env overlay through unchanged", () => {
    const inv = buildPowerShellInvocation(request({ cwd: "C:\\work", env: { FOO: "bar" } }));
    expect(inv.cwd).toBe("C:\\work");
    expect(inv.env).toEqual({ FOO: "bar" });
  });
});

describe("buildWindowsInvocation — WSL", () => {
  test("enters through wsl.exe and runs the command in a login shell", () => {
    const inv = buildWslInvocation(request({ shell: "wsl", command: "ls -la" }));
    expect(inv.file).toBe("wsl.exe");
    expect(inv.args).toEqual(["--", "bash", "-lc", "ls -la"]);
    // WSL sets its own working directory via --cd, not the spawn cwd.
    expect(inv.cwd).toBeNull();
  });

  test("adds the distribution and the working directory when given", () => {
    const inv = buildWslInvocation(request({ shell: "wsl", command: "pwd", distro: "Ubuntu", cwd: "/home/hass" }));
    expect(inv.args).toEqual(["--distribution", "Ubuntu", "--cd", "/home/hass", "--", "bash", "-lc", "pwd"]);
  });

  test("declares the env overlay keys in WSLENV so they cross into Linux", () => {
    const inv = buildWslInvocation(request({ shell: "wsl", command: "env", env: { A: "1", B: "2" } }));
    expect(inv.env.A).toBe("1");
    expect(inv.env.B).toBe("2");
    expect(inv.env.WSLENV).toBe("A/u:B/u");
  });

  test("leaves WSLENV unset when the overlay is empty", () => {
    const inv = buildWslInvocation(request({ shell: "wsl", command: "env" }));
    expect(inv.env.WSLENV).toBeUndefined();
  });

  test("appends a caller-supplied WSLENV after the declared keys", () => {
    const inv = buildWslInvocation(request({ shell: "wsl", command: "env", env: { A: "1", WSLENV: "PATH/l" } }));
    expect(inv.env.WSLENV).toBe("A/u:PATH/l");
  });
});

describe("buildWindowsInvocation — dispatch and helpers", () => {
  test("dispatches on the shell kind", () => {
    expect(buildWindowsInvocation(request({ shell: "powershell" })).file).toBe("powershell.exe");
    expect(buildWindowsInvocation(request({ shell: "wsl" })).file).toBe("wsl.exe");
  });

  test("the tree-kill command targets the pid, its tree, and forces it", () => {
    expect(treeKillCommand(4321)).toEqual(["taskkill", "/PID", "4321", "/T", "/F"]);
  });

  test("announces one capability per shell", () => {
    const runner = posixRunner();
    expect([...runner.capabilities]).toEqual(["exec:powershell", "exec:wsl"]);
    expect(execCapability("wsl")).toBe("exec:wsl");
  });
});

// --- Streaming against a real POSIX shell --------------------------------------------------------

describe("ShellRunner streaming", () => {
  test(
    "streams output incrementally, before the process exits, and in order",
    async () => {
      const sink = new CaptureSink();
      const firstChunk = new Promise<void>((resolve) => {
        sink.onFirst = resolve;
      });
      posixRunner().start(request({ command: "echo A; sleep 0.4; echo B" }), sink);

      await firstChunk;
      // The first line is delivered while the command still sleeps — output is not held until exit.
      expect(sink.exitOutcome).toBeNull();
      expect(sink.text("stdout")).toBe("A\n");

      await sink.done;
      expect(sink.text("stdout")).toBe("A\nB\n");
      expect(sink.exitOutcome).toEqual({ code: 0, signal: null, canceled: false });
    },
    10_000,
  );

  test("propagates a non-zero exit code", async () => {
    const sink = new CaptureSink();
    posixRunner().start(request({ command: "echo out; exit 7" }), sink);
    await sink.done;
    expect(sink.text("stdout")).toBe("out\n");
    expect(sink.exitOutcome).toEqual({ code: 7, signal: null, canceled: false });
  });

  test("keeps stdout and stderr apart", async () => {
    const sink = new CaptureSink();
    posixRunner().start(request({ command: "echo out; echo err 1>&2" }), sink);
    await sink.done;
    expect(sink.text("stdout")).toBe("out\n");
    expect(sink.text("stderr")).toBe("err\n");
  });

  test("applies the environment overlay to the command", async () => {
    const sink = new CaptureSink();
    posixRunner().start(request({ command: 'printf %s "$JAKE_TEST"', env: { JAKE_TEST: "xyz" } }), sink);
    await sink.done;
    expect(sink.text("stdout")).toBe("xyz");
  });

  test("runs in the requested working directory", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jake-exec-")));
    const sink = new CaptureSink();
    posixRunner().start(request({ command: "pwd", cwd: dir }), sink);
    await sink.done;
    expect(sink.text("stdout").trim()).toBe(dir);
  });
});

describe("ShellRunner cancellation", () => {
  test(
    "a cancel kills the whole process tree, not just the immediate child",
    async () => {
      const marker = join(realpathSync(mkdtempSync(join(tmpdir(), "jake-exec-"))), "alive");
      const sink = new CaptureSink();
      const ready = new Promise<void>((resolve) => {
        sink.onFirst = resolve;
      });
      // The immediate child echoes `ready`, then a grandchild touches the marker forever; `wait`
      // keeps the child alive so the tree, not one process, is what must be killed.
      const command = `sh -c 'while true; do sleep 0.1; touch ${marker}; done' & echo ready; wait`;
      const run = posixRunner().start(request({ command }), sink);

      await ready;
      // Wait until the grandchild has actually run — the marker exists — so the cancel has a live
      // tree to kill rather than racing the grandchild's first touch.
      for (let i = 0; i < 40 && !existsSync(marker); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(marker)).toBe(true);

      run.cancel();
      await sink.done;
      expect(sink.exitOutcome?.canceled).toBe(true);

      // The grandchild must have died with its parent: the marker stops being touched.
      const before = statSync(marker).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(statSync(marker).mtimeMs).toBe(before);
    },
    10_000,
  );

  test("a cancel after the run already finished is a no-op", async () => {
    const sink = new CaptureSink();
    const run = posixRunner().start(request({ command: "echo done" }), sink);
    await sink.done;
    expect(sink.exitOutcome?.canceled).toBe(false);
    expect(() => run.cancel()).not.toThrow();
  });
});

describe("ShellRunner caps", () => {
  test(
    "stops a command that exceeds the output cap and states the reason",
    async () => {
      const sink = new CaptureSink();
      // An unbounded producer; only the cap and the tree-kill stop it.
      posixRunner({ maxOutputBytes: 200 }).start(request({ command: "while true; do printf AAAAAAAAAA; done" }), sink);
      await sink.done;

      expect(sink.byteCount("stdout")).toBeLessThanOrEqual(200);
      expect(sink.byteCount("stdout")).toBeGreaterThan(0);
      expect(sink.text("stderr")).toContain("output cap of 200 bytes reached");
      // A cap stop is jake's doing, not an operator cancel.
      expect(sink.exitOutcome?.canceled).toBe(false);
    },
    10_000,
  );

  test(
    "stops a command that runs past the timeout and states the reason",
    async () => {
      const sink = new CaptureSink();
      const startedAt = Date.now();
      posixRunner({ timeoutMs: 250 }).start(request({ command: "sleep 30" }), sink);
      await sink.done;

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(sink.text("stderr")).toContain("time limit of 250 ms reached");
      expect(sink.exitOutcome?.canceled).toBe(false);
      // The process was killed rather than exiting on its own.
      expect(sink.exitOutcome?.signal).toBe("SIGKILL");
    },
    10_000,
  );
});

describe("ShellRunner failure to start", () => {
  test("reports a spawn error as a fail, not an exit", async () => {
    const throwingSpawner: Spawner = {
      spawn() {
        throw new Error('Executable not found in $PATH: "powershell.exe"');
      },
    };
    const runner = new ShellRunner({
      spawner: throwingSpawner,
      scheduler: systemScheduler,
      log: nullLogger,
      maxOutputBytes: 1024,
      timeoutMs: 1000,
      buildInvocation: posixBuild,
    });
    const sink = new CaptureSink();
    runner.start(request(), sink);
    await sink.done;
    expect(sink.exitOutcome).toBeNull();
    expect(sink.failure?.code).toBe("spawn-failed");
  });

  test("reports a command-build error as a fail", async () => {
    const runner = new ShellRunner({
      spawner: posixSpawner,
      scheduler: systemScheduler,
      log: nullLogger,
      maxOutputBytes: 1024,
      timeoutMs: 1000,
      buildInvocation: () => {
        throw new Error("cannot build");
      },
    });
    const sink = new CaptureSink();
    runner.start(request(), sink);
    await sink.done;
    expect(sink.failure?.code).toBe("build-failed");
  });
});
