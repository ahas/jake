// The wire protocol both sides of the tunnel import. The agent dials the hub and holds one
// connection open; over it, frames travel in both directions as text. This module owns the frame
// vocabulary, their on-the-wire encoding, and a decoder that turns an arbitrary string into a
// validated frame or a named rejection — never a raw throw. docs/protocol.md is the canonical
// statement of the vocabulary; this code answers to it.

/** The version every frame carries. A peer that speaks another version is refused, not guessed at. */
export const PROTOCOL_VERSION = 1;

/**
 * The default ceiling on a single frame's declared byte payload. It is a default, not a law: each
 * side reads its own ceiling from configuration and passes it to the decoder. Sixteen mebibytes is
 * far above any single chunk of command output, small enough that one frame cannot exhaust memory
 * on its own.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** The two shells the agent can run a command through on the Windows box. */
export type ShellKind = "powershell" | "wsl";

/**
 * A run of bytes carried inside a text frame. `bytes` is the decoded length, declared up front so a
 * receiver can refuse an oversized payload by reading one integer, before it ever allocates the
 * decoded buffer. `base64` is the standard-alphabet encoding of those bytes.
 */
export interface EncodedBytes {
  bytes: number;
  base64: string;
}

// --- Frames ------------------------------------------------------------------------------------

/** Agent → hub, first thing on a fresh connection: who it is and which shells it can run. */
export interface HelloFrame {
  type: "hello";
  v: number;
  agent: string;
  agentVersion: string;
  capabilities: string[];
}

/** Hub → agent, accepting the hello. */
export interface WelcomeFrame {
  type: "welcome";
  v: number;
  hubVersion: string;
}

/** Hub → agent, refusing the hello, with a stated reason. */
export interface RejectFrame {
  type: "reject";
  v: number;
  reason: string;
}

/** Hub → agent: run a command. `id` is the caller's own handle for every frame the run emits. */
export interface ExecFrame {
  type: "exec";
  v: number;
  id: string;
  shell: ShellKind;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  distro: string | null;
}

/** Agent → hub: a chunk of a run's standard output, in order by `seq`. */
export interface StdoutFrame {
  type: "stdout";
  v: number;
  id: string;
  seq: number;
  chunk: EncodedBytes;
}

/** Agent → hub: a chunk of a run's standard error, in order by `seq`. */
export interface StderrFrame {
  type: "stderr";
  v: number;
  id: string;
  seq: number;
  chunk: EncodedBytes;
}

/** Agent → hub: a run has ended. `canceled` tells a caller-ordered stop from a natural exit. */
export interface ExitFrame {
  type: "exit";
  v: number;
  id: string;
  code: number | null;
  signal: string | null;
  canceled: boolean;
}

/** Hub → agent: stop the run with this id, killing its whole process tree. */
export interface CancelFrame {
  type: "cancel";
  v: number;
  id: string;
}

/** Agent → hub (or hub → agent): a run request failed before it could stream, with a code and a message. */
export interface ErrorFrame {
  type: "error";
  v: number;
  id: string;
  code: string;
  message: string;
}

/** Either side: a liveness probe carrying the sender's clock. */
export interface PingFrame {
  type: "ping";
  v: number;
  ts: number;
}

/** Either side: the answer to a ping, echoing the probe's clock. */
export interface PongFrame {
  type: "pong";
  v: number;
  ts: number;
}

export type Frame =
  | HelloFrame
  | WelcomeFrame
  | RejectFrame
  | ExecFrame
  | StdoutFrame
  | StderrFrame
  | ExitFrame
  | CancelFrame
  | ErrorFrame
  | PingFrame
  | PongFrame;

export type FrameType = Frame["type"];

// --- Decoding ----------------------------------------------------------------------------------

/**
 * Why a string was not accepted as a frame. Each is a distinct, testable outcome so a caller can
 * tell a stranger's malformed input from a version drift from an oversized payload.
 */
export type FrameErrorCode =
  | "not-json"
  | "not-object"
  | "missing-type"
  | "unknown-type"
  | "version-mismatch"
  | "bad-field"
  | "payload-too-large";

export interface FrameError {
  code: FrameErrorCode;
  message: string;
}

export type DecodeResult =
  | { ok: true; frame: Frame }
  | { ok: false; error: FrameError };

/** The bytes-decoding outcome, kept separate so the envelope check need not allocate the buffer. */
export type BytesResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: FrameError };

export interface DecodeOptions {
  /** The largest declared payload this side will accept, in bytes. */
  maxPayloadBytes: number;
}

/** Serialise a frame for the wire. Frames go as text; binary rides inside as base64. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<FrameType>([
  "hello",
  "welcome",
  "reject",
  "exec",
  "stdout",
  "stderr",
  "exit",
  "cancel",
  "error",
  "ping",
  "pong",
]);

function fail(code: FrameErrorCode, message: string): { ok: false; error: FrameError } {
  return { ok: false, error: { code, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (!isString(entry)) {
      return false;
    }
  }

  return true;
}

const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

// The envelope check on an EncodedBytes-shaped field: enough to refuse an oversized or plainly
// broken payload without decoding it. The actual byte-for-byte decode is decodeBytes.
function checkEncodedBytes(
  value: unknown,
  field: string,
  maxPayloadBytes: number,
): FrameError | null {
  if (!isPlainObject(value)) {
    return { code: "bad-field", message: `${field} must be an object` };
  }

  if (!isInt(value.bytes) || value.bytes < 0) {
    return { code: "bad-field", message: `${field}.bytes must be a non-negative integer` };
  }

  if (value.bytes > maxPayloadBytes) {
    return {
      code: "payload-too-large",
      message: `${field}.bytes ${value.bytes} exceeds cap ${maxPayloadBytes}`,
    };
  }

  if (!isString(value.base64)) {
    return { code: "bad-field", message: `${field}.base64 must be a string` };
  }

  return null;
}

/**
 * Turn a received string into a validated frame or a named rejection. It parses JSON, confirms the
 * envelope is an object with a known type at the current protocol version, then checks the fields
 * that type requires. A declared binary payload larger than the cap is refused here, before its
 * base64 is decoded. Unknown extra fields are ignored; the returned frame carries only the fields
 * the type defines.
 */
export function decodeFrame(raw: string, options: DecodeOptions): DecodeResult {
  const { maxPayloadBytes } = options;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("not-json", "payload is not valid JSON");
  }

  if (!isPlainObject(parsed)) {
    return fail("not-object", "frame must be a JSON object");
  }

  if (!isString(parsed.type)) {
    return fail("missing-type", "frame is missing a string type");
  }

  const type = parsed.type;
  if (!KNOWN_TYPES.has(type)) {
    return fail("unknown-type", `unknown frame type ${type}`);
  }

  if (!isInt(parsed.v)) {
    return fail("bad-field", "v must be an integer");
  }
  if (parsed.v !== PROTOCOL_VERSION) {
    return fail("version-mismatch", `frame version ${parsed.v} is not ${PROTOCOL_VERSION}`);
  }

  const v = PROTOCOL_VERSION;

  switch (type) {
    case "hello": {
      if (!isString(parsed.agent)) return fail("bad-field", "hello.agent must be a string");
      if (!isString(parsed.agentVersion)) return fail("bad-field", "hello.agentVersion must be a string");
      if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every(isString)) {
        return fail("bad-field", "hello.capabilities must be a string array");
      }
      return {
        ok: true,
        frame: { type, v, agent: parsed.agent, agentVersion: parsed.agentVersion, capabilities: [...parsed.capabilities] },
      };
    }

    case "welcome": {
      if (!isString(parsed.hubVersion)) return fail("bad-field", "welcome.hubVersion must be a string");
      return { ok: true, frame: { type, v, hubVersion: parsed.hubVersion } };
    }

    case "reject": {
      if (!isString(parsed.reason)) return fail("bad-field", "reject.reason must be a string");
      return { ok: true, frame: { type, v, reason: parsed.reason } };
    }

    case "exec": {
      if (!isString(parsed.id)) return fail("bad-field", "exec.id must be a string");
      if (parsed.shell !== "powershell" && parsed.shell !== "wsl") {
        return fail("bad-field", "exec.shell must be 'powershell' or 'wsl'");
      }
      if (!isString(parsed.command)) return fail("bad-field", "exec.command must be a string");
      if (parsed.cwd !== null && !isString(parsed.cwd)) return fail("bad-field", "exec.cwd must be a string or null");
      if (!isStringRecord(parsed.env)) return fail("bad-field", "exec.env must be a string map");
      if (parsed.distro !== null && !isString(parsed.distro)) {
        return fail("bad-field", "exec.distro must be a string or null");
      }
      return {
        ok: true,
        frame: {
          type,
          v,
          id: parsed.id,
          shell: parsed.shell,
          command: parsed.command,
          cwd: parsed.cwd,
          env: { ...parsed.env },
          distro: parsed.distro,
        },
      };
    }

    case "stdout":
    case "stderr": {
      if (!isString(parsed.id)) return fail("bad-field", `${type}.id must be a string`);
      if (!isInt(parsed.seq) || parsed.seq < 0) return fail("bad-field", `${type}.seq must be a non-negative integer`);
      const chunkError = checkEncodedBytes(parsed.chunk, `${type}.chunk`, maxPayloadBytes);
      if (chunkError) return { ok: false, error: chunkError };
      const chunk = parsed.chunk as EncodedBytes;
      return { ok: true, frame: { type, v, id: parsed.id, seq: parsed.seq, chunk: { bytes: chunk.bytes, base64: chunk.base64 } } };
    }

    case "exit": {
      if (!isString(parsed.id)) return fail("bad-field", "exit.id must be a string");
      if (parsed.code !== null && !isInt(parsed.code)) return fail("bad-field", "exit.code must be an integer or null");
      if (parsed.signal !== null && !isString(parsed.signal)) return fail("bad-field", "exit.signal must be a string or null");
      if (typeof parsed.canceled !== "boolean") return fail("bad-field", "exit.canceled must be a boolean");
      return { ok: true, frame: { type, v, id: parsed.id, code: parsed.code, signal: parsed.signal, canceled: parsed.canceled } };
    }

    case "cancel": {
      if (!isString(parsed.id)) return fail("bad-field", "cancel.id must be a string");
      return { ok: true, frame: { type, v, id: parsed.id } };
    }

    case "error": {
      if (!isString(parsed.id)) return fail("bad-field", "error.id must be a string");
      if (!isString(parsed.code)) return fail("bad-field", "error.code must be a string");
      if (!isString(parsed.message)) return fail("bad-field", "error.message must be a string");
      return { ok: true, frame: { type, v, id: parsed.id, code: parsed.code, message: parsed.message } };
    }

    case "ping":
    case "pong": {
      if (!isFiniteNumber(parsed.ts)) return fail("bad-field", `${type}.ts must be a number`);
      return { ok: true, frame: { type, v, ts: parsed.ts } };
    }

    default:
      return fail("unknown-type", `unknown frame type ${type}`);
  }
}

// --- Byte payloads -----------------------------------------------------------------------------

/** Wrap raw bytes for a stdout/stderr chunk. */
export function encodeBytes(data: Uint8Array): EncodedBytes {
  return { bytes: data.byteLength, base64: Buffer.from(data).toString("base64") };
}

/**
 * Decode an EncodedBytes back to its bytes, re-checking the cap and verifying the decoded length
 * matches the declared one. This is where a buffer is finally allocated, so it is called only when
 * a side actually needs the bytes, not on every frame that crosses.
 */
export function decodeBytes(encoded: EncodedBytes, options: DecodeOptions): BytesResult {
  if (!isInt(encoded.bytes) || encoded.bytes < 0) {
    return fail("bad-field", "bytes must be a non-negative integer");
  }
  if (encoded.bytes > options.maxPayloadBytes) {
    return fail("payload-too-large", `bytes ${encoded.bytes} exceeds cap ${options.maxPayloadBytes}`);
  }
  if (!BASE64_SHAPE.test(encoded.base64) || encoded.base64.length % 4 !== 0) {
    return fail("bad-field", "base64 is not valid standard base64");
  }

  const data = new Uint8Array(Buffer.from(encoded.base64, "base64"));
  if (data.byteLength !== encoded.bytes) {
    return fail("bad-field", `decoded length ${data.byteLength} does not match declared ${encoded.bytes}`);
  }

  return { ok: true, data };
}
