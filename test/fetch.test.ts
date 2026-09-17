import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CallContext } from "../src/agent/capability";
import { FetchHandler, type FetchHandlerOptions } from "../src/agent/fetch";
import { nullLogger } from "../src/agent/log";

// --- A local server standing in for a URL on 하스's LAN -------------------------------------------

// The handler is exercised against a real server on an ephemeral port, since the whole point of the
// capability is a genuine HTTP round trip. The routes cover a text body, a JSON body, a non-2xx
// status, a bounded redirect chain, an unbounded redirect loop, a binary body, an oversized body,
// and an echo that reports the method and body it received so a redirect's method change is visible.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/text":
          return new Response("hello there", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "x-mark": "t" } });
        case "/json":
          return new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } });
        case "/notfound":
          return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
        case "/hop1":
          return new Response(null, { status: 302, headers: { location: "/hop2" } });
        case "/hop2":
          return new Response(null, { status: 302, headers: { location: "/text" } });
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop" } });
        case "/png":
          return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
        case "/nolabel":
          // No content-type: the handler treats an unlabelled body as binary.
          return new Response(PNG_BYTES, { status: 200 });
        case "/big":
          return new Response("x".repeat(1000), { status: 200, headers: { "content-type": "text/plain" } });
        case "/postredirect":
          return new Response(null, { status: 302, headers: { location: "/echo" } });
        case "/echo": {
          const body = await request.text();
          return new Response(`${request.method}:${body}`, { status: 200, headers: { "content-type": "text/plain" } });
        }
        default:
          return new Response("?", { status: 500 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function ctx(): CallContext {
  return { signal: new AbortController().signal, log: nullLogger };
}

function handler(overrides: Partial<FetchHandlerOptions> = {}): FetchHandler {
  return new FetchHandler({
    maxBodyBytes: overrides.maxBodyBytes ?? 1024 * 1024,
    maxRedirects: overrides.maxRedirects ?? 5,
    maxPayloadBytes: overrides.maxPayloadBytes ?? 16 * 1024 * 1024,
  });
}

// --- Parameter validation ------------------------------------------------------------------------

describe("FetchHandler — parameters", () => {
  test("rejects params that are not an object", async () => {
    const out = await handler().handle("nope", ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-params");
  });

  test("rejects a missing url", async () => {
    const out = await handler().handle({}, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-params");
  });

  test("rejects a malformed url", async () => {
    const out = await handler().handle({ url: "not a url" }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-url");
  });

  test("rejects a non-string header value", async () => {
    const out = await handler().handle({ url: `${base}/text`, headers: { x: 3 } }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("bad-params");
  });
});

// --- Success and status ---------------------------------------------------------------------------

describe("FetchHandler — success", () => {
  test("returns a text body as a string with status and headers", async () => {
    const out = await handler().handle({ url: `${base}/text` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.status).toBe(200);
      expect(value.bodyEncoding).toBe("text");
      expect(value.body).toBe("hello there");
      expect((value.headers as Record<string, string>)["x-mark"]).toBe("t");
      expect(value.finalUrl).toBe(`${base}/text`);
      expect(value.redirects).toEqual([]);
      expect(out.blob).toBeNull();
    }
  });

  test("returns JSON as text", async () => {
    const out = await handler().handle({ url: `${base}/json` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.bodyEncoding).toBe("text");
      expect(value.body).toBe('{"a":1}');
    }
  });

  test("passes the method and body through to the server", async () => {
    const out = await handler().handle({ url: `${base}/echo`, method: "POST", body: "payload" }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.value as Record<string, unknown>).body).toBe("POST:payload");
  });
});

// --- Non-2xx --------------------------------------------------------------------------------------

describe("FetchHandler — non-2xx", () => {
  test("reports a 404 as a successful fetch carrying the status and body", async () => {
    const out = await handler().handle({ url: `${base}/notfound` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.status).toBe(404);
      expect(value.body).toBe("nope");
    }
  });
});

// --- Redirects ------------------------------------------------------------------------------------

describe("FetchHandler — redirects", () => {
  test("follows a chain and reports the final URL and the hops", async () => {
    const out = await handler().handle({ url: `${base}/hop1` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.finalUrl).toBe(`${base}/text`);
      expect(value.redirects).toEqual([`${base}/hop2`, `${base}/text`]);
      expect(value.body).toBe("hello there");
    }
  });

  test("turns a POST into a bodyless GET across a 302", async () => {
    const out = await handler().handle({ url: `${base}/postredirect`, method: "POST", body: "payload" }, ctx());
    expect(out.ok).toBe(true);
    // The echo reports GET and an empty body: the method and body were reshaped by the redirect.
    if (out.ok) expect((out.value as Record<string, unknown>).body).toBe("GET:");
  });

  test("refuses a redirect chain past the bound", async () => {
    const out = await handler({ maxRedirects: 2 }).handle({ url: `${base}/loop` }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("too-many-redirects");
  });

  test("a per-call bound of zero follows no redirect", async () => {
    const out = await handler().handle({ url: `${base}/hop1`, maxRedirects: 0 }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("too-many-redirects");
  });
});

// --- Binary bodies --------------------------------------------------------------------------------

describe("FetchHandler — binary", () => {
  test("returns a binary body as a base64 blob labelled by content type", async () => {
    const out = await handler().handle({ url: `${base}/png` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      const value = out.value as Record<string, unknown>;
      expect(value.bodyEncoding).toBe("base64");
      expect(value.body).toBeUndefined();
      expect(out.blob?.contentType).toBe("image/png");
      expect(out.blob?.bytes).toBe(PNG_BYTES.byteLength);
      expect(new Uint8Array(Buffer.from(out.blob!.base64, "base64"))).toEqual(PNG_BYTES);
    }
  });

  test("treats an unlabelled body as binary", async () => {
    const out = await handler().handle({ url: `${base}/nolabel` }, ctx());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.value as Record<string, unknown>).bodyEncoding).toBe("base64");
      expect(out.blob?.contentType).toBe("application/octet-stream");
    }
  });
});

// --- Caps -----------------------------------------------------------------------------------------

describe("FetchHandler — caps", () => {
  test("refuses a body past the body cap rather than truncating it", async () => {
    const out = await handler({ maxBodyBytes: 100 }).handle({ url: `${base}/big` }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("body-too-large");
  });

  test("refuses a binary body past the frame payload cap", async () => {
    const out = await handler({ maxPayloadBytes: 4 }).handle({ url: `${base}/png` }, ctx());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("payload-too-large");
  });
});
