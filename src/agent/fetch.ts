// The fetch capability: a plain HTTP request made from inside 하스's network, so a URL only
// reachable from his LAN can be retrieved from here. The request's method, headers, and body go in;
// the response's status, headers, and body come out. A textual body rides back as a string in the
// result value; a binary body rides back as a base64 blob labelled with its content type, since
// the two travel differently over the wire. Redirects are followed by hand up to a bounded count —
// never silently past it — so the final URL and the chain that led there can be reported, and a
// body larger than the configured cap is refused rather than buffered whole.
//
// The connection core turns this handler's outcome into a result or error frame; the handler only
// does the fetch. `fetch` itself is injected so the handler is driven against a local server here.
// docs/architecture.md is the canonical statement of the agent's shape.

import { encodeBlob } from "../protocol";
import type { CallContext, CallHandler, CallOutcome } from "./capability";

/** The capability name the fetch handler contributes to the hello list. */
export const FETCH_CAPABILITY = "fetch";

/** The HTTP status codes that carry a redirect this handler will follow. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** The parameters a fetch call carries. Only the URL is required. */
export interface FetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** A text body, sent as UTF-8. Ignored for GET and HEAD, which carry no body. */
  body?: string;
  /** A binary body as standard base64. Takes precedence over `body` when both are given. */
  bodyBase64?: string;
  /** Override the configured redirect bound for this one call. */
  maxRedirects?: number;
}

/** What the fetch handler needs: the two caps, the redirect bound, and the fetch to make requests with. */
export interface FetchHandlerOptions {
  /** The largest response body to return, in bytes. A body past it is refused, not truncated. */
  maxBodyBytes: number;
  /** How many redirects to follow before refusing. A call may ask for fewer, never silently more. */
  maxRedirects: number;
  /** The frame payload cap; a binary body larger than this cannot cross, so it is refused. */
  maxPayloadBytes: number;
  /** The fetch implementation. Defaults to the global fetch; a test points it at a local server. */
  fetchImpl?: typeof fetch;
}

type ParseResult = { ok: true; value: FetchParams } | { ok: false; message: string };

function parseParams(params: unknown): ParseResult {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, message: "params must be an object" };
  }
  const record = params as Record<string, unknown>;

  if (typeof record.url !== "string" || record.url === "") {
    return { ok: false, message: "url must be a non-empty string" };
  }
  const value: FetchParams = { url: record.url };

  if (record.method !== undefined) {
    if (typeof record.method !== "string" || record.method === "") {
      return { ok: false, message: "method must be a non-empty string" };
    }
    value.method = record.method;
  }
  if (record.headers !== undefined) {
    if (typeof record.headers !== "object" || record.headers === null || Array.isArray(record.headers)) {
      return { ok: false, message: "headers must be an object" };
    }
    const headers: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record.headers)) {
      if (typeof entry !== "string") {
        return { ok: false, message: `header ${key} must be a string` };
      }
      headers[key] = entry;
    }
    value.headers = headers;
  }
  if (record.body !== undefined) {
    if (typeof record.body !== "string") {
      return { ok: false, message: "body must be a string" };
    }
    value.body = record.body;
  }
  if (record.bodyBase64 !== undefined) {
    if (typeof record.bodyBase64 !== "string") {
      return { ok: false, message: "bodyBase64 must be a string" };
    }
    value.bodyBase64 = record.bodyBase64;
  }
  if (record.maxRedirects !== undefined) {
    if (typeof record.maxRedirects !== "number" || !Number.isInteger(record.maxRedirects) || record.maxRedirects < 0) {
      return { ok: false, message: "maxRedirects must be a non-negative integer" };
    }
    value.maxRedirects = record.maxRedirects;
  }
  return { ok: true, value };
}

/** GET and HEAD carry no request body; fetch rejects one, so a body is only attached to other methods. */
function methodAllowsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/**
 * How a redirect reshapes the next request, following the same rules a browser uses. A 303 always
 * continues as GET without a body. A 301 or 302 keeps GET and HEAD as they are but turns any other
 * method (a POST, say) into a bodyless GET. A 307 or 308 preserves the method and the body exactly.
 */
function redirectNext(status: number, method: string): { method: string; dropBody: boolean } {
  if (status === 303) {
    return { method: method === "HEAD" ? "HEAD" : "GET", dropBody: true };
  }
  if (status === 301 || status === 302) {
    if (method === "GET" || method === "HEAD") {
      return { method, dropBody: false };
    }
    return { method: "GET", dropBody: true };
  }
  return { method, dropBody: false };
}

/** Delete every header whose name matches case-insensitively, so a body-dropping redirect is clean. */
function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

/** Flatten response headers into a plain record; a repeated header is joined the way Headers reports it. */
function flattenHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Whether a content type names text this side returns as a string rather than as a blob. The base
 * type is taken before any parameters. text/* is text; so is JSON and XML, whether the top type or a
 * `+json`/`+xml` structured suffix, along with a handful of application types that are plainly text.
 * Anything else — an image, an archive, an unlabelled body — is treated as binary.
 */
function isTextualContentType(contentType: string): boolean {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "") {
    return false;
  }
  if (base.startsWith("text/")) {
    return true;
  }
  if (base === "application/json" || base.endsWith("+json")) {
    return true;
  }
  if (base === "application/xml" || base.endsWith("+xml")) {
    return true;
  }
  return base === "application/javascript" || base === "application/ecmascript" || base === "application/x-www-form-urlencoded";
}

/**
 * Read a response body up to a cap, refusing to buffer past it. The body stream is read chunk by
 * chunk and abandoned the moment the running total would exceed the cap, so an unbounded download
 * cannot exhaust memory. A response with no body reads as zero bytes.
 */
async function readCappedBody(response: Response, cap: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel();
          return { ok: false };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The fetch capability handler. It makes the request the call named, following redirects by hand up
 * to the bound so the final URL and the chain are known, caps the body it will return, and reports
 * a text body as a string or a binary body as a content-typed blob. A malformed parameter, a bad
 * URL, a transport failure, an over-long redirect chain, and an over-cap body are each a distinct
 * named error rather than a thrown exception.
 */
export class FetchHandler implements CallHandler {
  readonly method = FETCH_CAPABILITY;

  private readonly maxBodyBytes: number;
  private readonly maxRedirects: number;
  private readonly maxPayloadBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchHandlerOptions) {
    this.maxBodyBytes = options.maxBodyBytes;
    this.maxRedirects = options.maxRedirects;
    this.maxPayloadBytes = options.maxPayloadBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async handle(params: unknown, ctx: CallContext): Promise<CallOutcome> {
    const parsed = parseParams(params);
    if (!parsed.ok) {
      return { ok: false, code: "bad-params", message: parsed.message };
    }
    const request = parsed.value;

    let currentUrl: string;
    try {
      currentUrl = new URL(request.url).toString();
    } catch {
      return { ok: false, code: "bad-url", message: `not a valid URL: ${request.url}` };
    }

    const redirectBound = request.maxRedirects ?? this.maxRedirects;
    let method = (request.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    let body: ArrayBuffer | string | undefined;
    if (request.bodyBase64 !== undefined) {
      const buf = Buffer.from(request.bodyBase64, "base64");
      body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } else if (request.body !== undefined) {
      body = request.body;
    }

    const redirects: string[] = [];
    let response: Response;
    let hops = 0;
    for (;;) {
      try {
        response = await this.fetchImpl(currentUrl, {
          method,
          headers,
          body: methodAllowsBody(method) ? body : undefined,
          redirect: "manual",
          signal: ctx.signal,
        });
      } catch (error) {
        return { ok: false, code: "fetch-failed", message: message(error) };
      }

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        if (hops >= redirectBound) {
          await response.body?.cancel();
          return {
            ok: false,
            code: "too-many-redirects",
            message: `redirect chain exceeded the limit of ${redirectBound}`,
          };
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          await response.body?.cancel();
          return { ok: false, code: "bad-redirect", message: `redirect to an invalid location: ${location}` };
        }
        const next = redirectNext(response.status, method);
        method = next.method;
        if (next.dropBody) {
          body = undefined;
          deleteHeader(headers, "content-type");
          deleteHeader(headers, "content-length");
        }
        await response.body?.cancel();
        redirects.push(nextUrl);
        currentUrl = nextUrl;
        hops += 1;
        continue;
      }
      break;
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const read = await readCappedBody(response, this.maxBodyBytes);
    if (!read.ok) {
      return {
        ok: false,
        code: "body-too-large",
        message: `response body exceeds the ${this.maxBodyBytes}-byte cap`,
      };
    }
    const bytes = read.bytes;

    const base = {
      status: response.status,
      statusText: response.statusText,
      headers: flattenHeaders(response.headers),
      finalUrl: currentUrl,
      redirects,
      bytes: bytes.byteLength,
    };

    if (bytes.byteLength === 0) {
      return { ok: true, value: { ...base, bodyEncoding: "empty" }, blob: null };
    }
    if (isTextualContentType(contentType)) {
      return { ok: true, value: { ...base, bodyEncoding: "text", body: new TextDecoder().decode(bytes) }, blob: null };
    }
    if (bytes.byteLength > this.maxPayloadBytes) {
      return {
        ok: false,
        code: "payload-too-large",
        message: `binary body is ${bytes.byteLength} bytes, over the ${this.maxPayloadBytes}-byte frame cap`,
      };
    }
    return { ok: true, value: { ...base, bodyEncoding: "base64" }, blob: encodeBlob(bytes, contentType) };
  }
}
