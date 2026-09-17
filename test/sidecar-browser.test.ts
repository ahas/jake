import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { BrowserSupervisor, bunSidecarSpawner } from "../src/agent/browser";
import { nullLogger } from "../src/agent/log";
import { systemScheduler } from "../src/agent/transport";

// Driving a real Chromium is platform-independent for the sidecar, which is ordinary Bun, so its own
// methods are exercised here on Linux — and through the whole agent path: the real child spawner, the
// sidecar's own stdio line loop, and a real browser. Everything but the compiled Windows exe (build-8's
// to produce) is proven to talk end to end. The framing and each method's request/response shape are
// checked separately against a fake driver in sidecar-rpc.test.ts; this file is the live-browser leg.
//
// Playwright's version-pinned download may not be present, so the test reaches whatever real Chromium
// this machine already has through the sidecar's executable-path override, and skips entirely when none
// is found rather than failing for want of a browser. One real browser runs at a time by design: two
// live Chromiums contend, so this is the suite's only browser and its calls are sequential.
function findBrowser(): string | null {
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"),
    join(home, ".cache/ms-playwright/chromium-1223/chrome-linux64/chrome"),
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const BROWSER = findBrowser();
const SIDECAR_DIR = join(import.meta.dir, "..", "sidecar");
// The suite spawns the real sidecar, which needs its own dependencies installed (they are gitignored,
// so a fresh checkout has none). Skip rather than fail when either the browser or those deps are absent.
const CAN_RUN = BROWSER !== null && existsSync(join(SIDECAR_DIR, "node_modules", "playwright-core"));

describe.skipIf(!CAN_RUN)("the real browser sidecar over the real spawner", () => {
  let supervisor: BrowserSupervisor;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  const signal = new AbortController().signal;

  beforeAll(() => {
    process.env.JAKE_SIDECAR_EXECUTABLE_PATH = BROWSER!;
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api") {
          return new Response(JSON.stringify({ hello: "from the page" }), { headers: { "content-type": "application/json" } });
        }
        return new Response(
          "<!doctype html><html><head><title>jake sidecar</title></head><body><h1 id=mark>hello world</h1></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    supervisor = new BrowserSupervisor({
      spawner: bunSidecarSpawner(["bun", join(SIDECAR_DIR, "index.ts")], SIDECAR_DIR),
      scheduler: systemScheduler,
      log: nullLogger,
      idleMs: 120_000,
      callTimeoutMs: 60_000,
      installHint: "unused",
    });
  });

  afterAll(() => {
    supervisor.stop();
    server.stop(true);
    delete process.env.JAKE_SIDECAR_EXECUTABLE_PATH;
  });

  // One test drives the full method set in order over the one shared page, so the single browser is
  // launched once and each of navigate, source, eval, shot, and fetch is exercised against it.
  test("navigate, source, eval, shot, and fetch all run against a live page", async () => {
    const nav = await supervisor.call("navigate", { url: base + "/" }, signal);
    expect(nav.ok).toBe(true);
    if (nav.ok) {
      const result = nav.result as { url: string; status: number | null };
      expect(result.status).toBe(200);
      expect(result.url).toBe(base + "/");
    }

    const source = await supervisor.call("source", {}, signal);
    expect(source.ok).toBe(true);
    if (source.ok) {
      const result = source.result as { html: string };
      expect(result.html).toContain("hello world");
      expect(result.html).toContain("<title>jake sidecar</title>");
    }

    const evaluated = await supervisor.call("eval", { expression: "document.title" }, signal);
    expect(evaluated.ok).toBe(true);
    if (evaluated.ok) expect((evaluated.result as { value: unknown }).value).toBe("jake sidecar");

    const shot = await supervisor.call("shot", {}, signal);
    expect(shot.ok).toBe(true);
    if (shot.ok) {
      const result = shot.result as { png: string; bytes: number };
      expect(result.bytes).toBeGreaterThan(0);
      const bytes = new Uint8Array(Buffer.from(result.png, "base64"));
      // A real PNG carries the eight-byte signature; its first four bytes are checked here.
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }

    const fetched = await supervisor.call("fetch", { url: base + "/api" }, signal);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      const result = fetched.result as { status: number; body: string; truncated: boolean };
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ hello: "from the page" });
      expect(result.truncated).toBe(false);
    }
  }, 120_000);
});
