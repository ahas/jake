// The browser sidecar's line protocol, kept apart from the browser it drives. The agent spawns the
// sidecar as a child and talks to it over standard input and output: one JSON request per line in,
// one JSON response per line out, correlated by an id. This module owns the framing — parsing a
// request line, formatting a response line — and the dispatch that turns a request into a call on a
// BrowserDriver and its result back into a response. The driver itself is a seam, so the framing and
// every method's request/response shape are checked in-process with a fake, and the real
// playwright-backed driver is exercised against a live Chromium separately. Nothing here imports
// playwright, so this file compiles and tests without a browser installed.

// --- The driver seam -----------------------------------------------------------------------------

/** How a page navigation settles: which lifecycle event to wait for before the call returns. */
export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

/** Parameters for a navigate call: the URL to open, an optional wait condition and timeout. */
export interface NavigateParams {
  url: string;
  waitUntil: WaitUntil;
  timeoutMs: number;
}

/** Parameters for a page-context fetch: a request the page itself issues, so its origin and cookies apply. */
export interface FetchParams {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  maxBytes: number;
}

/**
 * The one browser the sidecar owns, seen the way the dispatch needs it: navigate a single page, read
 * its source, photograph it, evaluate an expression in it, and fetch from inside its context. The
 * driver owns exactly one browser, one context, and one page at a time and creates them lazily on the
 * first call that needs a page. `close` shuts the browser down; the sidecar calls it on an idle
 * request or at exit. The real implementation drives playwright; a fake stands in for the shape tests.
 */
export interface BrowserDriver {
  navigate(params: NavigateParams): Promise<{ url: string; status: number | null }>;
  source(): Promise<{ url: string; html: string }>;
  /** Returns the PNG bytes; the dispatch base64-encodes them for the response line. */
  shot(params: { fullPage: boolean }): Promise<{ png: Uint8Array }>;
  evaluate(params: { expression: string }): Promise<{ value: unknown }>;
  fetch(params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }>;
  close(): Promise<void>;
}

// --- Frames --------------------------------------------------------------------------------------

/** The methods the sidecar answers, each naming one browser operation. */
export const SIDECAR_METHODS = ["navigate", "source", "shot", "eval", "fetch", "close"] as const;
export type SidecarMethod = (typeof SIDECAR_METHODS)[number];

/** One request the agent sends the sidecar: an id to correlate the answer, a method, and its params. */
export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

/** The sidecar's answer to one request: the same id, and either a result or a named error. */
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } };

/** Default caps and waits the sidecar applies when a call does not name its own. */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_UNTIL: WaitUntil = "load";
export const DEFAULT_FETCH_MAX_BYTES = 8 * 1024 * 1024;

// --- Framing (pure) ------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one received line into a request, or a named reason it is not one. A line that is not JSON,
 * that is not an object, or that lacks a numeric id or a string method is rejected rather than
 * thrown on — the sidecar keeps reading the next line rather than dying on a malformed one.
 */
export function parseRequestLine(line: string): { ok: true; request: RpcRequest } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, message: "request line is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, message: "request must be a JSON object" };
  }
  if (typeof parsed.id !== "number" || !Number.isInteger(parsed.id)) {
    return { ok: false, message: "request.id must be an integer" };
  }
  if (typeof parsed.method !== "string" || parsed.method === "") {
    return { ok: false, message: "request.method must be a non-empty string" };
  }
  return { ok: true, request: { id: parsed.id, method: parsed.method, params: parsed.params } };
}

/** Serialise a response as its wire line — one JSON object, no embedded newline. */
export function formatResponseLine(response: RpcResponse): string {
  return JSON.stringify(response);
}

function ok(id: number, result: unknown): RpcResponse {
  return { id, ok: true, result };
}

function err(id: number, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message } };
}

// --- Parameter validation (pure) -----------------------------------------------------------------

function requireString(record: Record<string, unknown>, field: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = record[field];
  if (typeof value !== "string" || value === "") {
    return { ok: false, message: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

function optionalPositiveInt(record: Record<string, unknown>, field: string, fallback: number): { ok: true; value: number } | { ok: false; message: string } {
  const value = record[field];
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${field} must be a positive integer` };
  }
  return { ok: true, value };
}

const WAIT_UNTIL_VALUES: ReadonlySet<string> = new Set<WaitUntil>(["load", "domcontentloaded", "networkidle", "commit"]);

type ParamsResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseNavigateParams(params: unknown): ParamsResult<NavigateParams> {
  if (!isRecord(params)) {
    return { ok: false, message: "params must be an object" };
  }
  const url = requireString(params, "url");
  if (!url.ok) return url;
  const timeout = optionalPositiveInt(params, "timeoutMs", DEFAULT_NAV_TIMEOUT_MS);
  if (!timeout.ok) return timeout;
  let waitUntil: WaitUntil = DEFAULT_WAIT_UNTIL;
  if (params.waitUntil !== undefined) {
    if (typeof params.waitUntil !== "string" || !WAIT_UNTIL_VALUES.has(params.waitUntil)) {
      return { ok: false, message: "waitUntil must be one of load, domcontentloaded, networkidle, commit" };
    }
    waitUntil = params.waitUntil as WaitUntil;
  }
  return { ok: true, value: { url: url.value, waitUntil, timeoutMs: timeout.value } };
}

export function parseShotParams(params: unknown): ParamsResult<{ fullPage: boolean }> {
  if (params === undefined || params === null) {
    return { ok: true, value: { fullPage: false } };
  }
  if (!isRecord(params)) {
    return { ok: false, message: "params must be an object" };
  }
  if (params.fullPage !== undefined && typeof params.fullPage !== "boolean") {
    return { ok: false, message: "fullPage must be a boolean" };
  }
  return { ok: true, value: { fullPage: params.fullPage === true } };
}

export function parseEvalParams(params: unknown): ParamsResult<{ expression: string }> {
  if (!isRecord(params)) {
    return { ok: false, message: "params must be an object" };
  }
  const expression = requireString(params, "expression");
  if (!expression.ok) return expression;
  return { ok: true, value: { expression: expression.value } };
}

export function parseFetchParams(params: unknown): ParamsResult<FetchParams> {
  if (!isRecord(params)) {
    return { ok: false, message: "params must be an object" };
  }
  const url = requireString(params, "url");
  if (!url.ok) return url;
  let method = "GET";
  if (params.method !== undefined) {
    if (typeof params.method !== "string" || params.method === "") {
      return { ok: false, message: "method must be a non-empty string" };
    }
    method = params.method.toUpperCase();
  }
  const headers: Record<string, string> = {};
  if (params.headers !== undefined) {
    if (!isRecord(params.headers)) {
      return { ok: false, message: "headers must be an object" };
    }
    for (const [key, value] of Object.entries(params.headers)) {
      if (typeof value !== "string") {
        return { ok: false, message: `header ${key} must be a string` };
      }
      headers[key] = value;
    }
  }
  let body: string | null = null;
  if (params.body !== undefined && params.body !== null) {
    if (typeof params.body !== "string") {
      return { ok: false, message: "body must be a string" };
    }
    body = params.body;
  }
  const maxBytes = optionalPositiveInt(params, "maxBytes", DEFAULT_FETCH_MAX_BYTES);
  if (!maxBytes.ok) return maxBytes;
  return { ok: true, value: { url: url.value, method, headers, body, maxBytes: maxBytes.value } };
}

// --- Dispatch ------------------------------------------------------------------------------------

/**
 * Turn one request into a response by calling the driver. Every method validates its own params and
 * answers a malformed one with a `bad-params` error rather than reaching the browser; an unknown
 * method is `unknown-method`; and any error the driver itself throws — a navigation timeout, a
 * browser that would not launch — is caught and returned as a `driver-error` response, so a single
 * failed call never takes the sidecar down. The shot's PNG bytes are base64-encoded here, the one
 * place binary crosses the line protocol.
 */
export async function dispatch(request: RpcRequest, driver: BrowserDriver): Promise<RpcResponse> {
  try {
    switch (request.method) {
      case "navigate": {
        const parsed = parseNavigateParams(request.params);
        if (!parsed.ok) return err(request.id, "bad-params", parsed.message);
        return ok(request.id, await driver.navigate(parsed.value));
      }
      case "source": {
        return ok(request.id, await driver.source());
      }
      case "shot": {
        const parsed = parseShotParams(request.params);
        if (!parsed.ok) return err(request.id, "bad-params", parsed.message);
        const { png } = await driver.shot(parsed.value);
        return ok(request.id, { png: Buffer.from(png).toString("base64"), bytes: png.byteLength });
      }
      case "eval": {
        const parsed = parseEvalParams(request.params);
        if (!parsed.ok) return err(request.id, "bad-params", parsed.message);
        return ok(request.id, await driver.evaluate(parsed.value));
      }
      case "fetch": {
        const parsed = parseFetchParams(request.params);
        if (!parsed.ok) return err(request.id, "bad-params", parsed.message);
        return ok(request.id, await driver.fetch(parsed.value));
      }
      case "close": {
        await driver.close();
        return ok(request.id, { closed: true });
      }
      default:
        return err(request.id, "unknown-method", `no browser method named ${request.method}`);
    }
  } catch (error) {
    return err(request.id, "driver-error", error instanceof Error ? error.message : String(error));
  }
}

// --- Line splitting (pure) -----------------------------------------------------------------------

/**
 * A running line splitter over a byte stream. The agent writes one request per line, but a read may
 * hand over a partial line or several at once, so bytes are buffered and only complete lines — those
 * ending in a newline — are yielded. Carriage returns before the newline are trimmed so a CRLF writer
 * is tolerated. This is the same shape the console's SSE reader uses on the other side of the tunnel.
 */
export class LineSplitter {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      let line = this.buffer.slice(0, index);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line !== "") {
        lines.push(line);
      }
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }
}
