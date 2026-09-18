import { describe, expect, test } from "bun:test";

import {
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_WAIT_UNTIL,
  dispatchBrowserCall,
  parseFetchParams,
  parseNavigateParams,
  parseShotParams,
  type BrowserDriver,
  type FetchParams,
  type NavigateParams,
} from "../src/agent/browser-ops";

// A driver that records what it was asked and either answers with a canned value or throws — enough
// to check that the dispatch validates params, routes to the right method, and maps a driver failure
// to a driver-error without a browser.
class RecordingDriver implements BrowserDriver {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  throwOn: string | null = null;
  async navigate(params: NavigateParams): Promise<{ url: string; status: number | null }> {
    this.record("navigate", params);
    return { url: params.url, status: 200 };
  }
  async source(): Promise<{ url: string; html: string }> {
    this.record("source", undefined);
    return { url: "http://x/", html: "<html></html>" };
  }
  async shot(params: { fullPage: boolean }): Promise<{ png: string; bytes: number }> {
    this.record("shot", params);
    return { png: "AAAA", bytes: 3 };
  }
  async evaluate(params: { expression: string }): Promise<{ value: unknown }> {
    this.record("eval", params);
    return { value: params.expression };
  }
  async fetch(params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    this.record("fetch", params);
    return { status: 200, statusText: "OK", headers: {}, body: "hi", bytes: 2, truncated: false };
  }
  async close(): Promise<void> {}
  private record(method: string, params: unknown): void {
    this.calls.push({ method, params });
    if (this.throwOn === method) {
      throw new Error(`${method} blew up`);
    }
  }
}

describe("parameter parsers", () => {
  test("navigate fills its defaults", () => {
    const parsed = parseNavigateParams({ url: "http://x/" });
    expect(parsed).toEqual({ ok: true, value: { url: "http://x/", waitUntil: DEFAULT_WAIT_UNTIL, timeoutMs: DEFAULT_NAV_TIMEOUT_MS } });
  });

  test("navigate rejects a missing url and a bad waitUntil", () => {
    expect(parseNavigateParams({}).ok).toBe(false);
    expect(parseNavigateParams({ url: "http://x/", waitUntil: "whenever" }).ok).toBe(false);
  });

  test("shot defaults fullPage to false and accepts a boolean", () => {
    expect(parseShotParams(undefined)).toEqual({ ok: true, value: { fullPage: false } });
    expect(parseShotParams({ fullPage: true })).toEqual({ ok: true, value: { fullPage: true } });
    expect(parseShotParams({ fullPage: "yes" }).ok).toBe(false);
  });

  test("fetch upcases the method and fills the byte cap", () => {
    const parsed = parseFetchParams({ url: "http://x/", method: "post", body: "b" });
    expect(parsed).toEqual({
      ok: true,
      value: { url: "http://x/", method: "POST", headers: {}, body: "b", maxBytes: DEFAULT_FETCH_MAX_BYTES },
    });
  });

  test("fetch rejects a non-string header value", () => {
    expect(parseFetchParams({ url: "http://x/", headers: { a: 1 } }).ok).toBe(false);
  });
});

describe("dispatchBrowserCall", () => {
  const signal = new AbortController().signal;
  void signal;

  test("routes each operation to its driver method", async () => {
    const driver = new RecordingDriver();
    expect(await dispatchBrowserCall(driver, "navigate", { url: "http://x/" })).toEqual({ ok: true, result: { url: "http://x/", status: 200 } });
    expect(await dispatchBrowserCall(driver, "source", {})).toEqual({ ok: true, result: { url: "http://x/", html: "<html></html>" } });
    expect(await dispatchBrowserCall(driver, "eval", { expression: "1+1" })).toEqual({ ok: true, result: { value: "1+1" } });
    expect(driver.calls.map((c) => c.method)).toEqual(["navigate", "source", "eval"]);
  });

  test("a malformed param is a bad-params outcome, before the driver is reached", async () => {
    const driver = new RecordingDriver();
    const outcome = await dispatchBrowserCall(driver, "navigate", {});
    expect(outcome).toEqual({ ok: false, code: "bad-params", message: "url must be a non-empty string" });
    expect(driver.calls).toHaveLength(0);
  });

  test("an unknown operation is an unknown-op outcome", async () => {
    const outcome = await dispatchBrowserCall(new RecordingDriver(), "teleport", {});
    expect(outcome).toEqual({ ok: false, code: "unknown-op", message: "no browser operation named teleport" });
  });

  test("a driver that throws becomes a driver-error outcome", async () => {
    const driver = new RecordingDriver();
    driver.throwOn = "eval";
    const outcome = await dispatchBrowserCall(driver, "eval", { expression: "boom" });
    expect(outcome).toEqual({ ok: false, code: "driver-error", message: "eval blew up" });
  });
});
