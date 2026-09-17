// The screenshot capability: a picture of 하스's Windows desktop, returned as a PNG. The capture
// goes through a spawned helper rather than a native addon — a native screen-grab addon carries its
// own reported instability under Bun and buys nothing here. The primary helper is a PowerShell
// one-liner that copies the screen into a bitmap with System.Drawing and saves a PNG; the fallback
// is a bundled nircmd.exe, for the case where machine policy blocks the PowerShell path. Both write
// the image to a temp file the handler then reads and returns, subject to the protocol's size cap.
//
// The command construction is pure, so both invocations are checked without a Windows desktop, and
// the spawner and filesystem are seams a test drives with fakes. The one thing a test here cannot do
// is exercise a real capture — there is no desktop on main-host to photograph. docs/architecture.md
// is the canonical statement of the agent's shape.

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBlob } from "../protocol";
import type { CallContext, CallHandler, CallOutcome } from "./capability";
import { encodePowerShellScript, type Invocation } from "./exec";

/** The capability name the screenshot handler contributes to the hello list. */
export const SCREENSHOT_CAPABILITY = "screenshot";

/** The token that asks for every monitor at once, joined into the one virtual screen. */
export const ALL_SCREENS = "all";

// --- Command-line construction (pure) ------------------------------------------------------------

/** Wrap a string as a PowerShell single-quoted literal, doubling any single quote it contains. */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the PowerShell script that captures the screen to a PNG at `outPath`. For the whole desktop
 * it takes the virtual-screen rectangle, which spans every monitor; for a named monitor it looks the
 * screen up by its device name and fails with a stated error when no such screen exists. The bitmap
 * is copied from the screen and saved as a PNG, and the graphics objects are disposed either way.
 */
export function buildScreenshotScript(outPath: string, screen: string): string {
  const pathLiteral = psSingleQuote(outPath);
  const lines: string[] = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
  ];
  if (screen === ALL_SCREENS) {
    lines.push("$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen");
  } else {
    const nameLiteral = psSingleQuote(screen);
    lines.push(
      `$target = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq ${nameLiteral} } | Select-Object -First 1`,
      `if ($null -eq $target) { Write-Error ('no screen named ' + ${nameLiteral}); exit 3 }`,
      "$bounds = $target.Bounds",
    );
  }
  lines.push(
    "$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "try {",
    "  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)",
    `  $bmp.Save(${pathLiteral}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    "} finally {",
    "  $g.Dispose()",
    "  $bmp.Dispose()",
    "}",
  );
  return lines.join("\n");
}

/**
 * Build the PowerShell invocation for a capture: the same non-interactive, no-profile,
 * policy-bypassed flags an exec run uses, with the capture script carried as an encoded command so
 * the path and the script cross the command line untouched.
 */
export function buildScreenshotInvocation(outPath: string, screen: string): Invocation {
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShellScript(buildScreenshotScript(outPath, screen)),
    ],
    cwd: null,
    env: {},
  };
}

/**
 * Build the nircmd invocation for the fallback capture. nircmd saves the full virtual screen — every
 * monitor — to a file; it does not select a single named monitor cheaply, so the fallback always
 * captures the whole desktop regardless of which screen was asked for.
 */
export function buildNircmdInvocation(nircmdPath: string, outPath: string): Invocation {
  return { file: nircmdPath, args: ["savescreenshotfull", outPath], cwd: null, env: {} };
}

// --- The spawner and filesystem seams ------------------------------------------------------------

/** How a capture helper ended: its exit code and whatever it wrote to standard error. */
export interface CaptureResult {
  code: number | null;
  stderr: string;
}

/** Runs a capture helper to completion. Injected, so the handler is driven by a fake here. */
export interface CaptureSpawner {
  run(invocation: Invocation, signal: AbortSignal): Promise<CaptureResult>;
}

/** The narrow filesystem the handler needs: read the written PNG, and remove the temp file after. */
export interface ScreenshotFs {
  /** Read a file's bytes, or null when it is missing or unreadable. */
  read(path: string): Promise<Uint8Array | null>;
  /** Remove a file. A path that is not there is not an error. */
  remove(path: string): Promise<void>;
}

// --- The handler ---------------------------------------------------------------------------------

/** What the screenshot handler needs: the seams, a temp-path source, the fallback path, and the cap. */
export interface ScreenshotHandlerOptions {
  spawner: CaptureSpawner;
  fs: ScreenshotFs;
  /** Produces a fresh temp file path for one capture. Injected so a test is deterministic. */
  tempPath: () => string;
  /** The path to the bundled nircmd.exe, or null when no fallback is available on this install. */
  nircmdPath: string | null;
  /** The frame payload cap; a PNG larger than this cannot cross, so it is refused. */
  maxPayloadBytes: number;
}

type ScreenshotParse = { ok: true; screen: string } | { ok: false; message: string };

function parseParams(params: unknown): ScreenshotParse {
  if (params === undefined || params === null) {
    return { ok: true, screen: ALL_SCREENS };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "params must be an object" };
  }
  const screen = (params as Record<string, unknown>).screen;
  if (screen === undefined || screen === null) {
    return { ok: true, screen: ALL_SCREENS };
  }
  if (typeof screen !== "string" || screen === "") {
    return { ok: false, message: "screen must be a non-empty string" };
  }
  return { ok: true, screen };
}

/**
 * The screenshot capability handler. It writes the capture to a temp file with PowerShell, reads it
 * back, and falls back to nircmd when the PowerShell path produced nothing — a policy block, say. A
 * capture that neither helper could produce, and a PNG past the frame cap, are each a stated error.
 * The temp file is removed whichever way the call ends.
 */
export class ScreenshotHandler implements CallHandler {
  readonly method = SCREENSHOT_CAPABILITY;

  private readonly spawner: CaptureSpawner;
  private readonly fs: ScreenshotFs;
  private readonly tempPath: () => string;
  private readonly nircmdPath: string | null;
  private readonly maxPayloadBytes: number;

  constructor(options: ScreenshotHandlerOptions) {
    this.spawner = options.spawner;
    this.fs = options.fs;
    this.tempPath = options.tempPath;
    this.nircmdPath = options.nircmdPath;
    this.maxPayloadBytes = options.maxPayloadBytes;
  }

  async handle(params: unknown, ctx: CallContext): Promise<CallOutcome> {
    const parsed = parseParams(params);
    if (!parsed.ok) {
      return { ok: false, code: "bad-params", message: parsed.message };
    }
    const screen = parsed.screen;
    const outPath = this.tempPath();

    try {
      const psResult = await this.spawner.run(buildScreenshotInvocation(outPath, screen), ctx.signal);
      let bytes = psResult.code === 0 ? await this.fs.read(outPath) : null;
      let via: "powershell" | "nircmd" = "powershell";

      if (bytes === null || bytes.byteLength === 0) {
        if (this.nircmdPath === null) {
          return {
            ok: false,
            code: "screenshot-failed",
            message: `PowerShell capture failed (${describeExit(psResult)}) and no nircmd fallback is available`,
          };
        }
        via = "nircmd";
        const ncResult = await this.spawner.run(buildNircmdInvocation(this.nircmdPath, outPath), ctx.signal);
        bytes = await this.fs.read(outPath);
        if (bytes === null || bytes.byteLength === 0) {
          return {
            ok: false,
            code: "screenshot-failed",
            message: `both PowerShell and nircmd captures produced no image (nircmd ${describeExit(ncResult)})`,
          };
        }
      }

      if (bytes.byteLength > this.maxPayloadBytes) {
        return {
          ok: false,
          code: "payload-too-large",
          message: `screenshot is ${bytes.byteLength} bytes, over the ${this.maxPayloadBytes}-byte frame cap`,
        };
      }

      // nircmd captures the whole desktop, so when the fallback ran the image is every screen even if
      // a single one was asked for. The result says both what was requested and what was captured.
      const captured = via === "nircmd" ? ALL_SCREENS : screen;
      return {
        ok: true,
        value: { requested: screen, captured, via, bytes: bytes.byteLength },
        blob: encodeBlob(bytes, "image/png"),
      };
    } finally {
      await this.fs.remove(outPath);
    }
  }
}

function describeExit(result: CaptureResult): string {
  const trimmed = result.stderr.trim();
  return trimmed === "" ? `exit ${result.code}` : `exit ${result.code}: ${trimmed}`;
}

// --- Real implementations ------------------------------------------------------------------------

/** The production spawner: run the helper, collect its stderr, and kill it if the call is abandoned. */
export const bunCaptureSpawner: CaptureSpawner = {
  async run(invocation, signal) {
    const proc = Bun.spawn([invocation.file, ...invocation.args], {
      stdout: "ignore",
      stderr: "pipe",
      cwd: invocation.cwd ?? undefined,
      env: { ...process.env, ...invocation.env },
    });
    const onAbort = (): void => {
      proc.kill();
    };
    if (signal.aborted) {
      proc.kill();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
      await proc.exited;
      return { code: proc.exitCode, stderr };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  },
};

/** The real filesystem the handler reads and cleans up through in production. */
export function diskScreenshotFs(): ScreenshotFs {
  return {
    async read(path) {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return null;
      }
    },
    async remove(path) {
      try {
        await unlink(path);
      } catch {
        // not there, or already gone — nothing to clean up
      }
    },
  };
}

/** A fresh temp PNG path for one capture, in the host's temp directory. */
export function tempPngPath(): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return join(tmpdir(), `jake-shot-${suffix}.png`);
}
