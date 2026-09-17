import { describe, expect, test } from "bun:test";

import type { CallContext } from "../src/agent/capability";
import type { Invocation } from "../src/agent/exec";
import { nullLogger } from "../src/agent/log";
import {
  ALL_SCREENS,
  buildNircmdInvocation,
  buildScreenshotInvocation,
  buildScreenshotScript,
  psSingleQuote,
  ScreenshotHandler,
  type CaptureResult,
  type CaptureSpawner,
  type ScreenshotFs,
} from "../src/agent/screenshot";

const OUT = "/tmp/jake-shot-test.png";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);

function ctx(): CallContext {
  return { signal: new AbortController().signal, log: nullLogger };
}

// --- Command-line construction (pure) ------------------------------------------------------------

describe("psSingleQuote", () => {
  test("wraps in single quotes and doubles an embedded quote", () => {
    expect(psSingleQuote("C:\\a\\b.png")).toBe("'C:\\a\\b.png'");
    expect(psSingleQuote("it's")).toBe("'it''s'");
  });
});

describe("buildScreenshotScript", () => {
  test("captures the virtual screen for the whole desktop", () => {
    const script = buildScreenshotScript(OUT, ALL_SCREENS);
    expect(script).toContain("Add-Type -AssemblyName System.Drawing");
    expect(script).toContain("[System.Windows.Forms.SystemInformation]::VirtualScreen");
    expect(script).toContain("CopyFromScreen");
    expect(script).toContain(`$bmp.Save('${OUT}', [System.Drawing.Imaging.ImageFormat]::Png)`);
    // No per-monitor lookup when the whole desktop is asked for.
    expect(script).not.toContain("AllScreens");
  });

  test("looks a named monitor up by device name and fails when it is absent", () => {
    const script = buildScreenshotScript(OUT, "\\\\.\\DISPLAY2");
    expect(script).toContain("[System.Windows.Forms.Screen]::AllScreens");
    expect(script).toContain("$_.DeviceName -eq '\\\\.\\DISPLAY2'");
    expect(script).toContain("$target.Bounds");
    expect(script).toContain("exit 3");
    expect(script).not.toContain("VirtualScreen");
  });
});

describe("buildScreenshotInvocation", () => {
  test("runs powershell non-interactively with the script as an encoded command", () => {
    const inv = buildScreenshotInvocation(OUT, ALL_SCREENS);
    expect(inv.file).toBe("powershell.exe");
    expect(inv.args).toContain("-NoProfile");
    expect(inv.args).toContain("-NonInteractive");
    const at = inv.args.indexOf("-EncodedCommand");
    expect(at).toBeGreaterThanOrEqual(0);
    const decoded = Buffer.from(inv.args[at + 1]!, "base64").toString("utf16le");
    expect(decoded).toBe(buildScreenshotScript(OUT, ALL_SCREENS));
  });
});

describe("buildNircmdInvocation", () => {
  test("captures the full virtual screen to the given file", () => {
    const inv = buildNircmdInvocation("C:\\jake\\nircmd.exe", OUT);
    expect(inv.file).toBe("C:\\jake\\nircmd.exe");
    expect(inv.args).toEqual(["savescreenshotfull", OUT]);
  });
});

// --- The handler over fake seams -----------------------------------------------------------------

// The fake filesystem holds written images by path and records every read and remove, so a test can
// preload an image, watch the handler read it, and confirm the temp file is cleaned up afterward.
class FakeFs implements ScreenshotFs {
  readonly files = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly removes: string[] = [];
  async read(path: string): Promise<Uint8Array | null> {
    this.reads.push(path);
    return this.files.get(path) ?? null;
  }
  async remove(path: string): Promise<void> {
    this.removes.push(path);
    this.files.delete(path);
  }
}

// A plan decides, per invocation, how the spawn ends and whether it produces an image at the out
// path — standing in for a real capture that either wrote a PNG or failed. Invocations are recorded
// in order so a test can confirm PowerShell ran first and nircmd only as a fallback.
type Plan = { code: number | null; stderr?: string; produces?: Uint8Array };

class FakeSpawner implements CaptureSpawner {
  readonly runs: Invocation[] = [];
  constructor(
    private readonly fs: FakeFs,
    private readonly outPath: string,
    private readonly plans: Plan[],
  ) {}
  async run(invocation: Invocation): Promise<CaptureResult> {
    const plan = this.plans[this.runs.length] ?? { code: 0 };
    this.runs.push(invocation);
    if (plan.produces !== undefined) {
      this.fs.files.set(this.outPath, plan.produces);
    }
    return { code: plan.code, stderr: plan.stderr ?? "" };
  }
}

function build(plans: Plan[], opts: { nircmdPath?: string | null; maxPayloadBytes?: number } = {}): {
  handler: ScreenshotHandler;
  fs: FakeFs;
  spawner: FakeSpawner;
} {
  const fs = new FakeFs();
  const spawner = new FakeSpawner(fs, OUT, plans);
  const handler = new ScreenshotHandler({
    spawner,
    fs,
    tempPath: () => OUT,
    nircmdPath: opts.nircmdPath === undefined ? "C:\\jake\\nircmd.exe" : opts.nircmdPath,
    maxPayloadBytes: opts.maxPayloadBytes ?? 16 * 1024 * 1024,
  });
  return { handler, fs, spawner };
}

describe("ScreenshotHandler — parameters", () => {
  test("rejects a non-object params", async () => {
    const { handler } = build([{ code: 0, produces: PNG }]);
    const out = await handler.handle(42, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-params");
  });

  test("rejects an empty screen name", async () => {
    const { handler } = build([{ code: 0, produces: PNG }]);
    const out = await handler.handle({ screen: "" }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-params");
  });
});

describe("ScreenshotHandler — PowerShell path", () => {
  test("returns the PNG the PowerShell capture wrote and cleans up", async () => {
    const { handler, fs, spawner } = build([{ code: 0, produces: PNG }]);
    const out = await handler.handle(undefined, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.via).toBe("powershell");
      expect(value.requested).toBe(ALL_SCREENS);
      expect(value.captured).toBe(ALL_SCREENS);
      expect(out.blob?.contentType).toBe("image/png");
      expect(out.blob?.bytes).toBe(PNG.byteLength);
      expect(new Uint8Array(Buffer.from(out.blob!.base64, "base64"))).toEqual(PNG);
    }
    expect(spawner.runs.length).toBe(1);
    expect(spawner.runs[0]!.file).toBe("powershell.exe");
    expect(fs.removes).toContain(OUT);
  });

  test("carries the requested monitor name through to the result", async () => {
    const { handler } = build([{ code: 0, produces: PNG }]);
    const out = await handler.handle({ screen: "\\\\.\\DISPLAY2" }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.requested).toBe("\\\\.\\DISPLAY2");
      expect(value.captured).toBe("\\\\.\\DISPLAY2");
    }
  });
});

describe("ScreenshotHandler — nircmd fallback", () => {
  test("falls back to nircmd when PowerShell produced no image", async () => {
    const { handler, spawner } = build([
      { code: 1, stderr: "blocked by policy" },
      { code: 0, produces: PNG },
    ]);
    const out = await handler.handle({ screen: "\\\\.\\DISPLAY2" }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.via).toBe("nircmd");
      // nircmd captures the whole desktop, so the named request became a full-desktop capture.
      expect(value.requested).toBe("\\\\.\\DISPLAY2");
      expect(value.captured).toBe(ALL_SCREENS);
    }
    expect(spawner.runs.length).toBe(2);
    expect(spawner.runs[0]!.file).toBe("powershell.exe");
    expect(spawner.runs[1]!.file).toBe("C:\\jake\\nircmd.exe");
  });

  test("errors when PowerShell failed and no nircmd fallback exists", async () => {
    const { handler, spawner } = build([{ code: 1, stderr: "blocked" }], { nircmdPath: null });
    const out = await handler.handle(undefined, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("screenshot-failed");
      expect(out.message).toContain("blocked");
    }
    expect(spawner.runs.length).toBe(1);
  });

  test("errors when neither PowerShell nor nircmd produced an image", async () => {
    const { handler, fs } = build([
      { code: 1 },
      { code: 2, stderr: "nircmd missing" },
    ]);
    const out = await handler.handle(undefined, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("screenshot-failed");
    // Even a wholly failed capture cleans up the temp path it may have created.
    expect(fs.removes).toContain(OUT);
  });
});

describe("ScreenshotHandler — cap", () => {
  test("refuses a PNG past the frame payload cap", async () => {
    const { handler } = build([{ code: 0, produces: PNG }], { maxPayloadBytes: 4 });
    const out = await handler.handle(undefined, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("payload-too-large");
  });
});
