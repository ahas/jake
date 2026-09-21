// The exec capability: running a command on the machine and streaming its output back.

import type { ShellKind } from "../protocol";
import type { ExecRequest, ExecRun, ExecRunner, ExecSink } from "./capability";
import type { Logger } from "./log";
import type { Scheduler, TimerHandle } from "./transport";

const encoder = new TextEncoder();

/** The capability name a shell contributes to the hello list: one per shell this build can run. */
export function execCapability(shell: ShellKind): string {
  return `exec:${shell}`;
}

// --- Command-line construction (pure) ------------------------------------------------------------

/**
 * A ready-to-spawn command: the executable, its arguments, an optional working directory (null means
 * inherit the agent's), and the environment overlay to lay over the base environment at spawn. The
 * overlay is only the additions — the spawner merges it over the real environment, since a child
 * that is handed a bare overlay would lose PATH and everything else it needs to run.
 */
export interface Invocation {
  file: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
}

// The prelude forces PowerShell's console output to UTF-8 so the bytes crossing the tunnel are not in
// the machine's OEM code page, where a non-ASCII character would arrive mojibake. It runs ahead of
// the caller's command inside the same encoded script.
const POWERSHELL_UTF8_PRELUDE =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8";

/**
 * Encode a PowerShell script the way `-EncodedCommand` expects it: base64 of the UTF-16LE bytes. This
 * is what lets an arbitrary command — quotes, newlines, semicolons and all — cross the command line
 * untouched, with no shell-quoting to get wrong.
 */
export function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Build the invocation for a PowerShell run. The flags make it non-interactive and unattended:
 * `-NoProfile` skips the user's profile, `-NonInteractive` refuses to prompt, `-ExecutionPolicy
 * Bypass` lets the command run whatever policy the machine carries, and the UTF-8 prelude fixes the
 * output encoding. The command itself travels as an encoded script so nothing in it needs quoting.
 */
export function buildPowerShellInvocation(request: ExecRequest): Invocation {
  const script = `${POWERSHELL_UTF8_PRELUDE}\n${request.command}`;
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      encodePowerShellScript(script),
    ],
    cwd: request.cwd,
    env: request.env,
  };
}

/**
 * Build the invocation for a WSL run. WSL is entered through `wsl.exe`, with an optional distribution
 * and an optional working directory it accepts through `--cd`. The command runs through a login shell
 * (`bash -lc`) so a `.bashrc`/`.profile` PATH and the like are in place, matching what a person would
 * get at an interactive prompt. An environment overlay only crosses the Windows→Linux boundary when
 * its names are listed in `WSLENV`, so the overlay's keys are declared there with the `/u` flag that
 * shares a variable into the Unix side.
 */
export function buildWslInvocation(request: ExecRequest): Invocation {
  const args: string[] = [];
  if (request.distro !== null && request.distro !== "") {
    args.push("--distribution", request.distro);
  }
  if (request.cwd !== null && request.cwd !== "") {
    args.push("--cd", request.cwd);
  }
  args.push("--", "bash", "-lc", request.command);

  const env: Record<string, string> = { ...request.env };
  const shared = Object.keys(request.env).filter((key) => key !== "WSLENV");
  if (shared.length > 0) {
    const declared = shared.map((key) => `${key}/u`).join(":");
    env.WSLENV = request.env.WSLENV ? `${declared}:${request.env.WSLENV}` : declared;
  }

  return { file: "wsl.exe", args, cwd: null, env };
}

/** Build the invocation for whichever shell a Windows host names. Pure, so both shapes are testable. */
export function buildWindowsInvocation(request: ExecRequest): Invocation {
  return request.shell === "wsl" ? buildWslInvocation(request) : buildPowerShellInvocation(request);
}

/**
 * Build the invocation for a Linux run. The command runs through a login shell (`bash -lc`) so a
 * `.bashrc`/`.profile` PATH and the like are in place, matching what a person gets at an interactive
 * prompt. Unlike WSL there is no launcher and no `WSLENV` bridge — the shell is the host's own, so the
 * working directory and the environment overlay apply directly at spawn, and `distro` has no meaning.
 */
export function buildLinuxInvocation(request: ExecRequest): Invocation {
  return {
    file: "bash",
    args: ["-lc", request.command],
    cwd: request.cwd,
    env: request.env,
  };
}

// --- The spawner seam ----------------------------------------------------------------------------

/**
 * One spawned command, seen the way the runner needs it: two byte streams read incrementally, a
 * promise that settles with how the process ended, and a way to end the whole process tree. A spawned
 * PowerShell that started something else must not leave that grandchild orphaned when the run is
 * stopped, so `killTree` ends the tree, not just the immediate child.
 */
export interface SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  killTree(): void;
}

/** Turns an invocation into a running process. Injected, so the runner is driven by a POSIX shell here. */
export interface Spawner {
  spawn(invocation: Invocation): SpawnedProcess;
}

/**
 * The Windows command that ends a whole process tree by pid. `/T` reaches the children, `/F` forces
 * it. Pure, so the one Windows-specific fragment this module carries is checked without Windows.
 */
export function treeKillCommand(pid: number): string[] {
  return ["taskkill", "/PID", String(pid), "/T", "/F"];
}

/**
 * The production spawner on 하스's Windows box. It spawns the invocation directly and ends the tree
 * with `taskkill /T /F`, which is the reliable way on Windows to reap a child that itself spawned
 * others. The environment overlay is merged over the real environment rather than replacing it.
 */
export const windowsSpawner: Spawner = {
  spawn(invocation) {
    const proc = Bun.spawn([invocation.file, ...invocation.args], {
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
        Bun.spawn(treeKillCommand(proc.pid), { stdout: "ignore", stderr: "ignore" });
      },
    };
  },
};

/**
 * How long a Linux process group is given to exit on the polite signal before it is forced, in
 * milliseconds. A tree that heeds SIGTERM leaves in far less; the forceful signal is the backstop.
 */
export const LINUX_TERM_GRACE_MS = 2_000;

/**
 * The production spawner on a Linux host. The command is launched under `setsid` so it leads a new
 * process group; ending the tree then signals the whole group by its negative pid — SIGTERM first,
 * escalating to SIGKILL if the group has not exited within the grace. That two-step is the Linux
 * equivalent of `taskkill /T /F`: a shell that started something else does not leave it orphaned. The
 * environment overlay is merged over the real environment rather than replacing it.
 */
export const linuxSpawner: Spawner = {
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
        const group = -proc.pid;
        try {
          process.kill(group, "SIGTERM");
        } catch {
          return; // the group is already gone
        }
        const force = setTimeout(() => {
          try {
            process.kill(group, "SIGKILL");
          } catch {
            // the group left on the polite signal
          }
        }, LINUX_TERM_GRACE_MS);
        // The escalation must not hold the process open, and it is moot once the group has exited.
        force.unref?.();
        void proc.exited.then(() => clearTimeout(force));
      },
    };
  },
};

// --- The runner ----------------------------------------------------------------------------------

/** What the shell runner needs: the spawner, a clock for the timeout, the two caps, and a log. */
export interface ShellRunnerOptions {
  spawner: Spawner;
  scheduler: Scheduler;
  log: Logger;
  /** The most output one command may stream before it is stopped, in bytes. */
  maxOutputBytes: number;
  /** The wall-clock ceiling on one command, in milliseconds. */
  timeoutMs: number;
  /** How each shell's command line is built. Defaults to the Windows construction. */
  buildInvocation?: (request: ExecRequest) => Invocation;
  /** The shells this runner advertises and can run. Defaults to the Windows pair. */
  shells?: readonly ShellKind[];
}

const DEFAULT_SHELLS: readonly ShellKind[] = ["powershell", "wsl"];

// Why a run ended on jake's initiative, kept apart from a natural exit. Only "cancel" — an operator
// stop — sets the exit frame's `canceled`; "cap" and "timeout" are jake stopping a runaway, and each
// states its reason as a final line of output so the operator sees why the command was cut off.
type EndReason = "cancel" | "cap" | "timeout";

const NOOP_RUN: ExecRun = { cancel() {} };

/**
 * The one component that turns an exec frame into a running command and streams its output back. It
 * spawns through the injected spawner, reads both pipes incrementally so a prompt-less program never
 * looks hung waiting for a full line, enforces the output cap and the wall-clock timeout, and stops
 * the whole process tree on a cancel. A run that never starts is reported through the sink's `fail`;
 * a run that starts always ends through `exit`.
 */
export class ShellRunner implements ExecRunner {
  /** The capability names announced in the hello: one per shell this runner's platform can run. */
  readonly capabilities: readonly string[];

  private readonly spawner: Spawner;
  private readonly scheduler: Scheduler;
  private readonly log: Logger;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;
  private readonly buildInvocation: (request: ExecRequest) => Invocation;

  constructor(options: ShellRunnerOptions) {
    this.spawner = options.spawner;
    this.scheduler = options.scheduler;
    this.log = options.log;
    this.maxOutputBytes = options.maxOutputBytes;
    this.timeoutMs = options.timeoutMs;
    this.buildInvocation = options.buildInvocation ?? buildWindowsInvocation;
    this.capabilities = (options.shells ?? DEFAULT_SHELLS).map(execCapability);
  }

  start(request: ExecRequest, sink: ExecSink): ExecRun {
    let invocation: Invocation;
    try {
      invocation = this.buildInvocation(request);
    } catch (error) {
      sink.fail("build-failed", message(error));
      return NOOP_RUN;
    }

    let proc: SpawnedProcess;
    try {
      proc = this.spawner.spawn(invocation);
    } catch (error) {
      // A shell that is not present, or a spawn the OS refused: the run never started.
      sink.fail("spawn-failed", message(error));
      return NOOP_RUN;
    }

    let endReason: EndReason | null = null;
    let settled = false;
    let produced = 0;

    const terminate = (reason: EndReason): void => {
      // The first reason wins; a later cause of death does not change the story the operator is told.
      if (endReason !== null) {
        return;
      }
      endReason = reason;
      try {
        proc.killTree();
      } catch (error) {
        this.log.log("warn", "exec-kill-threw", { id: request.id, error: message(error) });
      }
    };

    const timer: TimerHandle = this.scheduler.setTimeout(() => terminate("timeout"), this.timeoutMs);

    const forward = (kind: "stdout" | "stderr", chunk: Uint8Array): void => {
      // Once jake has decided to stop the run, further output is dropped so the cap stays a real bound
      // and the reason line is the last thing the operator sees.
      if (endReason !== null) {
        return;
      }
      const remaining = this.maxOutputBytes - produced;
      if (remaining <= 0) {
        terminate("cap");
        return;
      }
      if (chunk.byteLength > remaining) {
        const head = chunk.subarray(0, remaining);
        produced += head.byteLength;
        sink[kind](head);
        terminate("cap");
        return;
      }
      produced += chunk.byteLength;
      sink[kind](chunk);
    };

    const pump = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr"): Promise<void> => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            return;
          }
          if (value !== undefined) {
            forward(kind, value);
          }
        }
      } catch (error) {
        // A read that fails mid-stream ends this pipe; the process's own exit still settles the run.
        this.log.log("warn", "exec-read-threw", { id: request.id, kind, error: message(error) });
      } finally {
        reader.releaseLock();
      }
    };

    // Report the one exit, at most once. A cap or timeout states its reason as a final output line,
    // just before the exit, so it is always the last thing on the stream.
    const finalize = (ended: { code: number | null; signal: string | null }): void => {
      this.scheduler.clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      if (endReason === "cap") {
        sink.stderr(encoder.encode(`\n[jake] output cap of ${this.maxOutputBytes} bytes reached; command terminated\n`));
      } else if (endReason === "timeout") {
        sink.stderr(encoder.encode(`\n[jake] time limit of ${this.timeoutMs} ms reached; command terminated\n`));
      }
      sink.exit({ code: ended.code, signal: ended.signal, canceled: endReason === "cancel" });
    };

    // Wait for both pipes to drain and the process to exit. Killing the tree closes the pipes, so a
    // cap, a timeout, or a cancel all reach here the same way. If the exit status can never be read,
    // the run is still ended rather than left hanging in the core's map until the socket drops.
    void Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr"), proc.exited])
      .then(([, , ended]) => finalize(ended))
      .catch((error: unknown) => {
        this.log.log("warn", "exec-exit-threw", { id: request.id, error: message(error) });
        finalize({ code: null, signal: null });
      });

    return { cancel: () => terminate("cancel") };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
