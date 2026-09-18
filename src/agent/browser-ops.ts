// The five browser operations, apart from the browser that performs them. Each call the agent
// forwards — navigate a page, read its source, photograph it, evaluate an expression in it, and
// fetch from inside its context — validates its own parameters here and is turned into a call on a
// BrowserDriver. The driver is a seam: the real one drives Edge over CDP, and a fake stands in for
// the shape tests, so every parameter check and every result shape is exercised on this machine with
// no browser. Nothing here reaches a browser or the protocol wire. docs/architecture.md is canonical.

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
 * The one browser the agent drives, seen the way the dispatch needs it: navigate a single page, read
 * its source, photograph it, evaluate an expression in it, and fetch from inside its context. The
 * driver owns exactly one page at a time, created lazily on the first call that needs one. `close`
 * ends the browser. The real implementation speaks CDP to Edge; a fake stands in for the shape tests.
 */
export interface BrowserDriver {
  navigate(params: NavigateParams): Promise<{ url: string; status: number | null }>;
  source(): Promise<{ url: string; html: string }>;
  /** Returns the PNG as base64 with its decoded byte length, ready to carry as a blob. */
  shot(params: { fullPage: boolean }): Promise<{ png: string; bytes: number }>;
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

/** The settled outcome of one browser operation, before a handler shapes it into a capability result. */
export type BrowserCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/** The operations the agent dispatches, each naming one browser method. */
export const BROWSER_OPS = ["navigate", "source", "shot", "eval", "fetch"] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];

/** Default caps and waits applied when a call does not name its own. */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_UNTIL: WaitUntil = "load";
export const DEFAULT_FETCH_MAX_BYTES = 8 * 1024 * 1024;

// --- Parameter validation (pure) -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParamsResult<T> = { ok: true; value: T } | { ok: false; message: string };

function requireString(record: Record<string, unknown>, field: string): ParamsResult<string> {
  const value = record[field];
  if (typeof value !== "string" || value === "") {
    return { ok: false, message: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

function optionalPositiveInt(record: Record<string, unknown>, field: string, fallback: number): ParamsResult<number> {
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
 * Turn one operation into an outcome by calling the driver. Each method validates its own params and
 * answers a malformed one with a `bad-params` error rather than reaching the browser; an unknown
 * operation is `unknown-op`; and any error the driver itself throws — a navigation timeout, a page
 * gone — is caught and returned as a `driver-error` outcome, so a single failed call never crashes
 * the agent. The lifecycle around this — launching the browser, the per-call timeout, an abandoned
 * connection — is the engine's, not this function's.
 */
export async function dispatchBrowserCall(driver: BrowserDriver, op: string, params: unknown): Promise<BrowserCallOutcome> {
  try {
    switch (op) {
      case "navigate": {
        const parsed = parseNavigateParams(params);
        if (!parsed.ok) return { ok: false, code: "bad-params", message: parsed.message };
        return { ok: true, result: await driver.navigate(parsed.value) };
      }
      case "source": {
        return { ok: true, result: await driver.source() };
      }
      case "shot": {
        const parsed = parseShotParams(params);
        if (!parsed.ok) return { ok: false, code: "bad-params", message: parsed.message };
        return { ok: true, result: await driver.shot(parsed.value) };
      }
      case "eval": {
        const parsed = parseEvalParams(params);
        if (!parsed.ok) return { ok: false, code: "bad-params", message: parsed.message };
        return { ok: true, result: await driver.evaluate(parsed.value) };
      }
      case "fetch": {
        const parsed = parseFetchParams(params);
        if (!parsed.ok) return { ok: false, code: "bad-params", message: parsed.message };
        return { ok: true, result: await driver.fetch(parsed.value) };
      }
      default:
        return { ok: false, code: "unknown-op", message: `no browser operation named ${op}` };
    }
  } catch (error) {
    return { ok: false, code: "driver-error", message: error instanceof Error ? error.message : String(error) };
  }
}
