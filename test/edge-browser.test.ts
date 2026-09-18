import { afterAll, beforeAll, describe, expect } from "bun:test";
import { test } from "bun:test";
import { existsSync } from "node:fs";

import { WebSocketCdpDialer } from "../src/agent/cdp";
import type { BrowserSession } from "../src/agent/browser";
import { edgeBackend, realEdgeLauncher } from "../src/agent/edge";
import { nullLogger } from "../src/agent/log";

// The real driver, exercised against an actual Chromium-family browser over CDP — the same protocol
// the agent speaks to Edge on 하스's box. Edge is not on main-host, but Chrome is, and the two speak
// identical CDP, so a Chrome (or any configured browser) stands in. When no browser is found the
// whole suite skips rather than failing, so a machine without one still passes the run.
function findBrowser(): string | null {
  const candidates = [
    process.env.JAKE_TEST_BROWSER,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter((path): path is string => path !== undefined && path !== "");
  return candidates.find((path) => existsSync(path)) ?? null;
}

const browserPath = findBrowser();
const itBrowser = browserPath === null ? test.skip : test;

const PAGE = `<!doctype html><html><head><title>jake test</title></head><body><h1 id="h">hi</h1></body></html>`;

describe("edge backend — a real browser over CDP", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base = "";
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/data.json") {
          return Response.json({ hello: "world" });
        }
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    if (browserPath !== null) {
      const backend = edgeBackend(
        realEdgeLauncher({ executablePath: browserPath, headless: true, startupTimeoutMs: 20_000, log: nullLogger }),
        new WebSocketCdpDialer(),
      );
      session = await backend.open();
    }
  }, 30_000);

  afterAll(() => {
    session?.close();
    server?.stop(true);
  });

  itBrowser(
    "navigates and reports the page status",
    async () => {
      const result = await session!.driver.navigate({ url: `${base}/`, waitUntil: "load", timeoutMs: 15_000 });
      expect(result.status).toBe(200);
      expect(result.url).toContain("127.0.0.1");
    },
    20_000,
  );

  itBrowser(
    "reads the page source",
    async () => {
      await session!.driver.navigate({ url: `${base}/`, waitUntil: "load", timeoutMs: 15_000 });
      const source = await session!.driver.source();
      expect(source.html).toContain("jake test");
      expect(source.html).toContain('id="h"');
    },
    20_000,
  );

  itBrowser(
    "evaluates an expression in the page",
    async () => {
      await session!.driver.navigate({ url: `${base}/`, waitUntil: "load", timeoutMs: 15_000 });
      const evaluated = await session!.driver.evaluate({ expression: "document.title" });
      expect(evaluated.value).toBe("jake test");
    },
    20_000,
  );

  itBrowser(
    "captures a screenshot as PNG bytes",
    async () => {
      await session!.driver.navigate({ url: `${base}/`, waitUntil: "load", timeoutMs: 15_000 });
      const shot = await session!.driver.shot({ fullPage: false });
      expect(shot.bytes).toBeGreaterThan(0);
      const png = Buffer.from(shot.png, "base64");
      expect(png.byteLength).toBe(shot.bytes);
      // The PNG signature: the first eight bytes every PNG opens with.
      expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
    20_000,
  );

  itBrowser(
    "fetches from inside the page context",
    async () => {
      await session!.driver.navigate({ url: `${base}/`, waitUntil: "load", timeoutMs: 15_000 });
      const fetched = await session!.driver.fetch({
        url: `${base}/data.json`,
        method: "GET",
        headers: {},
        body: null,
        maxBytes: 1 << 20,
      });
      expect(fetched.status).toBe(200);
      expect(JSON.parse(fetched.body)).toEqual({ hello: "world" });
      expect(fetched.truncated).toBe(false);
    },
    20_000,
  );
});
