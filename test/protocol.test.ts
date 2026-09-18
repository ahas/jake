import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type Frame,
} from "../src/protocol";

const V = PROTOCOL_VERSION;
const OPTS = { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES };

const helloBytes = encodeBytes(new TextEncoder().encode("line of output\n"));

const everyFrame: Frame[] = [
  { type: "hello", v: V, agent: "jake-hass", agentVersion: "0.1.0", capabilities: ["exec:powershell", "exec:wsl"] },
  { type: "welcome", v: V, hubVersion: "0.1.0" },
  { type: "reject", v: V, reason: "secret mismatch" },
  { type: "exec", v: V, id: "c1", shell: "powershell", command: "Get-Date", cwd: null, env: {}, distro: null },
  { type: "exec", v: V, id: "c2", shell: "wsl", command: "ls -la", cwd: "/home", env: { LANG: "C.UTF-8" }, distro: "Ubuntu" },
  { type: "stdout", v: V, id: "c1", seq: 0, chunk: helloBytes },
  { type: "stderr", v: V, id: "c1", seq: 1, chunk: helloBytes },
  { type: "exit", v: V, id: "c1", code: 0, signal: null, canceled: false },
  { type: "exit", v: V, id: "c2", code: null, signal: "SIGTERM", canceled: true },
  { type: "cancel", v: V, id: "c2" },
  { type: "error", v: V, id: "c3", code: "spawn-failed", message: "powershell.exe was not found" },
  { type: "ping", v: V, ts: 1_726_600_000_000 },
  { type: "pong", v: V, ts: 1_726_600_000_001 },
];

describe("frame round-trip", () => {
  for (const frame of everyFrame) {
    const label = "id" in frame ? `${frame.type}/${(frame as { id: string }).id}` : frame.type;
    test(`round-trips ${label}`, () => {
      const result = decodeFrame(encodeFrame(frame), OPTS);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.frame).toEqual(frame);
      }
    });
  }

  test("covers every frame kind", () => {
    const kinds = new Set(everyFrame.map((f) => f.type));
    expect([...kinds].sort()).toEqual(
      ["cancel", "error", "exec", "exit", "hello", "ping", "pong", "reject", "stderr", "stdout", "welcome"],
    );
  });

  test("drops unknown extra fields", () => {
    const result = decodeFrame(JSON.stringify({ type: "ping", v: V, ts: 5, extra: "ignored" }), OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame).toEqual({ type: "ping", v: V, ts: 5 });
    }
  });
});

describe("decode rejections", () => {
  function reject(raw: string): string {
    const result = decodeFrame(raw, OPTS);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error.code;
  }

  test("not JSON", () => {
    expect(reject("{not json")).toBe("not-json");
  });

  test("not an object", () => {
    expect(reject("[1,2,3]")).toBe("not-object");
    expect(reject("42")).toBe("not-object");
  });

  test("missing type", () => {
    expect(reject(JSON.stringify({ v: V, ts: 1 }))).toBe("missing-type");
  });

  test("unknown type", () => {
    expect(reject(JSON.stringify({ type: "teleport", v: V }))).toBe("unknown-type");
    expect(reject(JSON.stringify({ type: "call", v: V, id: "r", method: "screenshot", params: null }))).toBe("unknown-type");
    expect(reject(JSON.stringify({ type: "result", v: V, id: "r", value: null, blob: null }))).toBe("unknown-type");
  });

  test("unknown version", () => {
    expect(reject(JSON.stringify({ type: "ping", v: 999, ts: 1 }))).toBe("version-mismatch");
    expect(reject(JSON.stringify({ type: "ping", v: "1", ts: 1 }))).toBe("bad-field");
  });

  test("malformed fields", () => {
    expect(reject(JSON.stringify({ type: "exec", v: V, id: "c", shell: "bash", command: "x", cwd: null, env: {}, distro: null }))).toBe("bad-field");
    expect(reject(JSON.stringify({ type: "exec", v: V, id: "c", shell: "powershell", cwd: null, env: {}, distro: null }))).toBe("bad-field");
    expect(reject(JSON.stringify({ type: "hello", v: V, agent: "a", agentVersion: "1", capabilities: [1, 2] }))).toBe("bad-field");
    expect(reject(JSON.stringify({ type: "exit", v: V, id: "c", code: 0, signal: null, canceled: "no" }))).toBe("bad-field");
    expect(reject(JSON.stringify({ type: "error", v: V, id: "c", code: "x" }))).toBe("bad-field");
    expect(reject(JSON.stringify({ type: "stdout", v: V, id: "c", seq: -1, chunk: helloBytes }))).toBe("bad-field");
  });
});

describe("payload size cap", () => {
  const tinyOpts = { maxPayloadBytes: 8 };

  test("refuses an oversized stdout chunk before decoding", () => {
    const frame = { type: "stdout", v: V, id: "c", seq: 0, chunk: { bytes: 9, base64: "" } };
    const result = decodeFrame(JSON.stringify(frame), tinyOpts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("payload-too-large");
    }
  });

  test("accepts a payload at the cap", () => {
    const chunk = encodeBytes(new Uint8Array(8));
    const frame = { type: "stdout", v: V, id: "c", seq: 0, chunk };
    expect(decodeFrame(JSON.stringify(frame), tinyOpts).ok).toBe(true);
  });
});

describe("byte payloads", () => {
  test("encode then decode round-trips the bytes", () => {
    const data = new Uint8Array([1, 2, 3, 250, 0, 128]);
    const result = decodeBytes(encodeBytes(data), OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.data]).toEqual([...data]);
    }
  });

  test("rejects a declared length that does not match the bytes", () => {
    const encoded = encodeBytes(new Uint8Array([1, 2, 3]));
    const result = decodeBytes({ ...encoded, bytes: encoded.bytes + 1 }, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-field");
    }
  });

  test("rejects non-base64", () => {
    const result = decodeBytes({ bytes: 3, base64: "not base64!!" }, OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad-field");
    }
  });

  test("rejects bytes over the cap", () => {
    const encoded = encodeBytes(new Uint8Array(16));
    const result = decodeBytes(encoded, { maxPayloadBytes: 8 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("payload-too-large");
    }
  });
});
