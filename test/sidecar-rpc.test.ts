import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_WAIT_UNTIL,
  dispatch,
  formatResponseLine,
  LineSplitter,
  parseRequestLine,
  type BrowserDriver,
  type FetchParams,
  type NavigateParams,
  type RpcRequest,
} from "../sidecar/rpc";

// A fake driver: it records every call it receives and answers with canned data, so the framing and
// dispatch are checked without a browser. One method can be made to throw, to prove a driver failure
// becomes a driver-error response rather than taking the sidecar down.
class FakeDriver implements BrowserDriver {
  readonly calls: { method: string; args: unknown }[] = [];
  throwOn: string | null = null;

  private maybeThrow(method: string): void {
    if (this.throwOn === method) {
      throw new Error(`${method} boom`);
    }
  }
  async navigate(params: NavigateParams): Promise<{ url: string; status: number | null }> {
    this.calls.push({ method: "navigate", args: params });
    this.maybeThrow("navigate");
    return { url: params.url, status: 200 };
  }
  async source(): Promise<{ url: string; html: string }> {
    this.calls.push({ method: "source", args: undefined });
    return { url: "http://example.test/", html: "<html><body>hi</body></html>" };
  }
  async shot(params: { fullPage: boolean }): Promise<{ png: Uint8Array }> {
    this.calls.push({ method: "shot", args: params });
    return { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
  }
  async evaluate(params: { expression: string }): Promise<{ value: unknown }> {
    this.calls.push({ method: "evaluate", args: params });
    return { value: 42 };
  }
  async fetch(params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    this.calls.push({ method: "fetch", args: params });
    return { status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, body: "hi", bytes: 2, truncated: false };
  }
  async close(): Promise<void> {
    this.calls.push({ method: "close", args: undefined });
  }
}

function request(id: number, method: string, params: unknown): RpcRequest {
  return { id, method, params };
}

// --- Framing (pure) ------------------------------------------------------------------------------

describe("parseRequestLine", () => {
  test("accepts a well-formed request", () => {
    const parsed = parseRequestLine(JSON.stringify({ id: 7, method: "navigate", params: { url: "http://x/" } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.id).toBe(7);
      expect(parsed.request.method).toBe("navigate");
    }
  });

  test("rejects non-JSON, a non-object, a bad id, and a bad method", () => {
    expect(parseRequestLine("not json").ok).toBe(false);
    expect(parseRequestLine("[1,2,3]").ok).toBe(false);
    expect(parseRequestLine(JSON.stringify({ id: "x", method: "navigate" })).ok).toBe(false);
    expect(parseRequestLine(JSON.stringify({ id: 1, method: "" })).ok).toBe(false);
    expect(parseRequestLine(JSON.stringify({ id: 1 })).ok).toBe(false);
  });
});

describe("formatResponseLine", () => {
  test("serialises a response as a single line with no embedded newline", () => {
    const line = formatResponseLine({ id: 3, ok: true, result: { a: 1 } });
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ id: 3, ok: true, result: { a: 1 } });
  });
});

describe("LineSplitter", () => {
  test("buffers a partial line until its newline arrives", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(s.push(enc.encode('{"id":1'))).toEqual([]);
    expect(s.push(enc.encode('}\n'))).toEqual(['{"id":1}']);
  });

  test("yields several complete lines from one chunk and tolerates CRLF and blanks", () => {
    const s = new LineSplitter();
    const enc = new TextEncoder();
    expect(s.push(enc.encode("a\r\n\nb\n"))).toEqual(["a", "b"]);
  });
});

// --- Dispatch ------------------------------------------------------------------------------------

describe("dispatch — navigate", () => {
  test("passes the URL through with default wait and timeout, and returns url and status", async () => {
    const driver = new FakeDriver();
    const response = await dispatch(request(1, "navigate", { url: "http://example.test/" }), driver);
    expect(response).toEqual({ id: 1, ok: true, result: { url: "http://example.test/", status: 200 } });
    expect(driver.calls[0]).toEqual({
      method: "navigate",
      args: { url: "http://example.test/", waitUntil: DEFAULT_WAIT_UNTIL, timeoutMs: DEFAULT_NAV_TIMEOUT_MS },
    });
  });

  test("rejects a missing URL and an unknown waitUntil as bad-params, without reaching the driver", async () => {
    const driver = new FakeDriver();
    const noUrl = await dispatch(request(2, "navigate", {}), driver);
    const badWait = await dispatch(request(3, "navigate", { url: "http://x/", waitUntil: "whenever" }), driver);
    expect(noUrl.ok).toBe(false);
    expect(badWait.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.error.code).toBe("bad-params");
    if (!badWait.ok) expect(badWait.error.code).toBe("bad-params");
    expect(driver.calls.length).toBe(0);
  });
});

describe("dispatch — source, eval, fetch", () => {
  test("source returns the page url and html", async () => {
    const response = await dispatch(request(4, "source", {}), new FakeDriver());
    expect(response).toEqual({ id: 4, ok: true, result: { url: "http://example.test/", html: "<html><body>hi</body></html>" } });
  });

  test("eval requires an expression and returns the value", async () => {
    const driver = new FakeDriver();
    const good = await dispatch(request(5, "eval", { expression: "1 + 1" }), driver);
    const bad = await dispatch(request(6, "eval", {}), driver);
    expect(good).toEqual({ id: 5, ok: true, result: { value: 42 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("bad-params");
  });

  test("fetch validates params and returns the response shape", async () => {
    const driver = new FakeDriver();
    const good = await dispatch(request(7, "fetch", { url: "http://x/", method: "get" }), driver);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect((good.result as { status: number }).status).toBe(200);
    }
    // The method is upper-cased before it reaches the driver.
    expect((driver.calls[0]!.args as FetchParams).method).toBe("GET");
    const badHeader = await dispatch(request(8, "fetch", { url: "http://x/", headers: { a: 1 } }), driver);
    expect(badHeader.ok).toBe(false);
    if (!badHeader.ok) expect(badHeader.error.code).toBe("bad-params");
  });
});

describe("dispatch — shot", () => {
  test("base64-encodes the PNG bytes with their declared length", async () => {
    const response = await dispatch(request(9, "shot", { fullPage: true }), new FakeDriver());
    expect(response.ok).toBe(true);
    if (response.ok) {
      const result = response.result as { png: string; bytes: number };
      expect(result.bytes).toBe(4);
      expect(new Uint8Array(Buffer.from(result.png, "base64"))).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  test("rejects a non-boolean fullPage", async () => {
    const response = await dispatch(request(10, "shot", { fullPage: "yes" }), new FakeDriver());
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("bad-params");
  });
});

describe("dispatch — close, unknown, and driver failure", () => {
  test("close asks the driver to close and reports it", async () => {
    const driver = new FakeDriver();
    const response = await dispatch(request(11, "close", {}), driver);
    expect(response).toEqual({ id: 11, ok: true, result: { closed: true } });
    expect(driver.calls[0]!.method).toBe("close");
  });

  test("an unknown method is a named error", async () => {
    const response = await dispatch(request(12, "teleport", {}), new FakeDriver());
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("unknown-method");
  });

  test("an error the driver throws becomes a driver-error, not a crash", async () => {
    const driver = new FakeDriver();
    driver.throwOn = "navigate";
    const response = await dispatch(request(13, "navigate", { url: "http://x/" }), driver);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("driver-error");
      expect(response.error.message).toContain("boom");
    }
  });
});
