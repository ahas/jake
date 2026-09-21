import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  TRANSFER_CHUNK_BYTES,
  checksum,
  decodeBytes,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type Frame,
} from "../src/protocol";
import { AgentConnection, type ConnectionDeps } from "../src/agent/connection";
import type { Logger } from "../src/agent/log";
import {
  FileTransferRunner,
  nodeTransferFs,
  type TransferFs,
  type TransferSink,
} from "../src/agent/transfer";
import type { Scheduler, Transport } from "../src/agent/transport";
import { HubCore, type AgentLink, type HubCoreOptions, type TransferEvent, type TransferListener } from "../src/hub/core";

const V = PROTOCOL_VERSION;
const OPTS = { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES };
const silentLog: Logger = { log() {} };

// A macrotask-based poll: the runner's file I/O settles over microtasks and real fs ticks, so a test
// waits on the outcome it expects rather than a fixed sleep.
async function until(pred: () => boolean, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met in time");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

// --- Capturing seams ------------------------------------------------------------------------------

type SinkCall =
  | { kind: "begin"; total: number; checksum: string }
  | { kind: "chunk"; seq: number; bytes: Uint8Array }
  | { kind: "end"; total: number; checksum: string }
  | { kind: "fail"; code: string; message: string };

class CaptureSink implements TransferSink {
  readonly calls: SinkCall[] = [];
  begin(total: number, sum: string): void {
    this.calls.push({ kind: "begin", total, checksum: sum });
  }
  chunk(seq: number, bytes: Uint8Array): void {
    this.calls.push({ kind: "chunk", seq, bytes: Uint8Array.from(bytes) });
  }
  end(total: number, sum: string): void {
    this.calls.push({ kind: "end", total, checksum: sum });
  }
  fail(code: string, message: string): void {
    this.calls.push({ kind: "fail", code, message });
  }
  last(): SinkCall | undefined {
    return this.calls.at(-1);
  }
  assembled(): Uint8Array {
    const chunks = this.calls.filter((c): c is Extract<SinkCall, { kind: "chunk" }> => c.kind === "chunk");
    chunks.sort((a, b) => a.seq - b.seq);
    return concat(chunks.map((c) => c.bytes));
  }
}

class CaptureListener implements TransferListener {
  readonly events: TransferEvent[] = [];
  ended = false;
  push(event: TransferEvent): void {
    this.events.push(event);
  }
  end(): void {
    this.ended = true;
  }
  terminal(): TransferEvent | undefined {
    return this.events.find((e) => e.kind === "completed" || e.kind === "error" || e.kind === "ended");
  }
  assembled(): Uint8Array {
    const chunks = this.events.filter((e): e is Extract<TransferEvent, { kind: "chunk" }> => e.kind === "chunk");
    chunks.sort((a, b) => a.seq - b.seq);
    return concat(
      chunks.map((c) => {
        const decoded = decodeBytes(c.chunk, OPTS);
        if (!decoded.ok) throw new Error("bad chunk in listener");
        return decoded.data;
      }),
    );
  }
}

// --- Temp directories, cleaned up after each case -------------------------------------------------

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jake-transfer-"));
  dirs.push(dir);
  return dir;
}

const cores: HubCore[] = [];
function makeCore(): HubCore {
  const options: HubCoreOptions = {
    secret: "s",
    controlToken: "c",
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    hubVersion: "test",
  };
  const core = new HubCore(options);
  cores.push(core);
  return core;
}

afterEach(() => {
  for (const core of cores.splice(0)) core.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// --- Agent-side runner: uploads -------------------------------------------------------------------

describe("FileTransferRunner upload", () => {
  test("streams a multi-chunk upload to a temp file and moves it into place, then acknowledges", async () => {
    const dir = tempDir();
    const path = join(dir, "out.bin");
    const data = randomBytes(4000); // many chunks at the tiny chunk size below
    const sum = checksum(data);
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog, chunkBytes: 64 });
    const sink = new CaptureSink();

    runner.begin({ id: "u1", direction: "upload", path, total: data.byteLength, checksum: sum }, sink);
    let seq = 0;
    for (let offset = 0; offset < data.byteLength; offset += 64) {
      runner.chunk("u1", seq++, encodeBytes(data.subarray(offset, Math.min(offset + 64, data.byteLength))));
    }
    runner.end("u1", data.byteLength, sum);

    await until(() => sink.last() !== undefined && (sink.last()!.kind === "end" || sink.last()!.kind === "fail"));
    expect(sink.last()).toMatchObject({ kind: "end", total: data.byteLength, checksum: sum });
    expect(sameBytes(new Uint8Array(readFileSync(path)), new Uint8Array(data))).toBe(true);
    // No temporary file is left beside the target.
    expect(readdirSync(dir)).toEqual(["out.bin"]);
  });

  test("a checksum mismatch is caught: no file is written and an error is reported", async () => {
    const dir = tempDir();
    const path = join(dir, "out.bin");
    const data = randomBytes(500);
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog, chunkBytes: 64 });
    const sink = new CaptureSink();

    runner.begin({ id: "u2", direction: "upload", path, total: data.byteLength, checksum: checksum(data) }, sink);
    let seq = 0;
    for (let offset = 0; offset < data.byteLength; offset += 64) {
      runner.chunk("u2", seq++, encodeBytes(data.subarray(offset, Math.min(offset + 64, data.byteLength))));
    }
    // Close with a checksum that does not match the bytes actually sent.
    runner.end("u2", data.byteLength, "0".repeat(64));

    await until(() => sink.last()?.kind === "fail");
    expect(sink.last()).toMatchObject({ kind: "fail", code: "integrity" });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // the temp was discarded
  });

  test("a full disk surfaces as an error frame, mirroring the exec error path", async () => {
    const failing: TransferFs = {
      ...nodeTransferFs,
      async createWrite() {
        const error = new Error("no space left on device") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      },
    };
    const runner = new FileTransferRunner({ fs: failing, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog });
    const sink = new CaptureSink();

    runner.begin({ id: "u3", direction: "upload", path: "/whatever/out.bin", total: 3, checksum: checksum(new Uint8Array([1, 2, 3])) }, sink);
    runner.chunk("u3", 0, encodeBytes(new Uint8Array([1, 2, 3])));
    runner.end("u3", 3, checksum(new Uint8Array([1, 2, 3])));

    await until(() => sink.last()?.kind === "fail");
    expect(sink.last()).toMatchObject({ kind: "fail", code: "disk-full" });
  });

  test("a chunk arriving out of order fails the transfer rather than assembling a gap", async () => {
    const dir = tempDir();
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog, chunkBytes: 64 });
    const sink = new CaptureSink();
    runner.begin({ id: "u4", direction: "upload", path: join(dir, "out.bin"), total: 6, checksum: "x" }, sink);
    runner.chunk("u4", 0, encodeBytes(new Uint8Array([1, 2, 3])));
    runner.chunk("u4", 2, encodeBytes(new Uint8Array([4, 5, 6]))); // seq 1 skipped

    await until(() => sink.last()?.kind === "fail");
    expect(sink.last()).toMatchObject({ kind: "fail", code: "out-of-order" });
  });
});

// --- Agent-side runner: downloads -----------------------------------------------------------------

describe("FileTransferRunner download", () => {
  test("reads a large file in bounded chunks, declaring a checksum the bytes verify against", async () => {
    const dir = tempDir();
    const src = join(dir, "src.bin");
    const data = randomBytes(4000);
    writeFileSync(src, data);
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog, chunkBytes: 64 });
    const sink = new CaptureSink();

    runner.begin({ id: "d1", direction: "download", path: src, total: null, checksum: null }, sink);
    await until(() => sink.last() !== undefined && (sink.last()!.kind === "end" || sink.last()!.kind === "fail"));

    const begin = sink.calls.find((c) => c.kind === "begin");
    expect(begin).toMatchObject({ kind: "begin", total: data.byteLength, checksum: checksum(data) });
    expect(sink.last()).toMatchObject({ kind: "end", total: data.byteLength, checksum: checksum(data) });
    expect(sameBytes(sink.assembled(), new Uint8Array(data))).toBe(true);
    // Every chunk was held under the configured chunk size.
    for (const call of sink.calls) {
      if (call.kind === "chunk") expect(call.bytes.byteLength).toBeLessThanOrEqual(64);
    }
  });

  test("a missing file is reported as not-found rather than a silent empty stream", async () => {
    const dir = tempDir();
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog });
    const sink = new CaptureSink();
    runner.begin({ id: "d2", direction: "download", path: join(dir, "nope.bin"), total: null, checksum: null }, sink);

    await until(() => sink.last()?.kind === "fail");
    expect(sink.last()).toMatchObject({ kind: "fail", code: "not-found" });
    expect(sink.calls.some((c) => c.kind === "begin")).toBe(false);
  });

  test("a permission denial surfaces as a permission error", async () => {
    const failing: TransferFs = {
      ...nodeTransferFs,
      async size() {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    };
    const runner = new FileTransferRunner({ fs: failing, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog });
    const sink = new CaptureSink();
    runner.begin({ id: "d3", direction: "download", path: "/root/secret", total: null, checksum: null }, sink);

    await until(() => sink.last()?.kind === "fail");
    expect(sink.last()).toMatchObject({ kind: "fail", code: "permission" });
  });
});

// --- Hub-side routing -----------------------------------------------------------------------------

function attachAgent(core: HubCore): { link: AgentLink; sent: Frame[] } {
  const sent: Frame[] = [];
  const link: AgentLink = {
    socketId: core.nextSocketId(),
    send(text) {
      const result = decodeFrame(text, OPTS);
      if (result.ok) sent.push(result.frame);
    },
    close() {},
  };
  core.onMessage(link, encodeFrame({ type: "hello", v: V, agent: "hass", agentVersion: "0.1.0", capabilities: ["transfer"] }));
  return { link, sent };
}

function chunkFrame(id: string, seq: number, bytes: Uint8Array): Frame {
  return { type: "transfer-chunk", v: V, id, seq, chunk: encodeBytes(bytes) };
}

describe("HubCore transfer routing", () => {
  test("drives an upload as chunk frames and completes on the agent's acknowledgement", () => {
    const core = makeCore();
    const { link, sent } = attachAgent(core);
    const data = randomBytes(600_000); // exceeds the fixed chunk size, so it is sent as several chunks
    const sum = checksum(data);
    const listener = new CaptureListener();

    const result = core.startUpload({ path: "C:\\out.bin", data }, listener);
    expect(result.ok).toBe(true);
    const id = result.ok ? result.id : "";

    const begin = sent.find((f) => f.type === "transfer-begin");
    expect(begin).toMatchObject({ type: "transfer-begin", direction: "upload", path: "C:\\out.bin", total: data.byteLength, checksum: sum });
    const chunks = sent.filter((f): f is Extract<Frame, { type: "transfer-chunk" }> => f.type === "transfer-chunk");
    expect(chunks.length).toBeGreaterThan(1);
    const assembled = concat(
      chunks.map((f) => {
        const decoded = decodeBytes(f.chunk, OPTS);
        if (!decoded.ok) throw new Error("bad chunk");
        return decoded.data;
      }),
    );
    expect(sameBytes(assembled, new Uint8Array(data))).toBe(true);
    expect(sent.some((f) => f.type === "transfer-end")).toBe(true);

    // The agent acknowledges the verified write.
    core.onMessage(link, encodeFrame({ type: "transfer-end", v: V, id, total: data.byteLength, checksum: sum }));
    expect(listener.terminal()).toMatchObject({ kind: "completed", total: data.byteLength });
    expect(listener.ended).toBe(true);
  });

  test("requests a download, verifies the assembled bytes, and completes", () => {
    const core = makeCore();
    const { link, sent } = attachAgent(core);
    const listener = new CaptureListener();
    const result = core.startDownload({ path: "/home/hass/notes.txt" }, listener);
    const id = result.ok ? result.id : "";

    const request = sent.find((f) => f.type === "transfer-begin");
    expect(request).toMatchObject({ type: "transfer-begin", direction: "download", path: "/home/hass/notes.txt", total: null, checksum: null });

    const data = randomBytes(600_000);
    const sum = checksum(data);
    core.onMessage(link, encodeFrame({ type: "transfer-begin", v: V, id, direction: "download", path: "/home/hass/notes.txt", total: data.byteLength, checksum: sum }));
    let seq = 0;
    for (let offset = 0; offset < data.byteLength; offset += TRANSFER_CHUNK_BYTES) {
      core.onMessage(link, encodeFrame(chunkFrame(id, seq++, data.subarray(offset, Math.min(offset + TRANSFER_CHUNK_BYTES, data.byteLength)))));
    }
    core.onMessage(link, encodeFrame({ type: "transfer-end", v: V, id, total: data.byteLength, checksum: sum }));

    expect(listener.events.find((e) => e.kind === "begin")).toMatchObject({ total: data.byteLength, checksum: sum });
    expect(sameBytes(listener.assembled(), new Uint8Array(data))).toBe(true);
    expect(listener.terminal()).toMatchObject({ kind: "completed" });
  });

  test("a download whose assembled bytes do not match the declared checksum is rejected", () => {
    const core = makeCore();
    const { link } = attachAgent(core);
    const listener = new CaptureListener();
    const id = (core.startDownload({ path: "/x" }, listener) as { id: string }).id;

    const data = randomBytes(1000);
    core.onMessage(link, encodeFrame({ type: "transfer-begin", v: V, id, direction: "download", path: "/x", total: data.byteLength, checksum: "0".repeat(64) }));
    core.onMessage(link, encodeFrame(chunkFrame(id, 0, data)));
    // The end declares a checksum the assembled bytes cannot match.
    core.onMessage(link, encodeFrame({ type: "transfer-end", v: V, id, total: data.byteLength, checksum: "0".repeat(64) }));

    expect(listener.terminal()).toMatchObject({ kind: "error", code: "integrity" });
  });

  test("an error frame for a transfer ends it as failed", () => {
    const core = makeCore();
    const { link } = attachAgent(core);
    const listener = new CaptureListener();
    const id = (core.startDownload({ path: "/missing" }, listener) as { id: string }).id;
    core.onMessage(link, encodeFrame({ type: "error", v: V, id, code: "not-found", message: "no such file" }));
    expect(listener.terminal()).toMatchObject({ kind: "error", code: "not-found" });
  });

  test("a transfer against a hub with no agent is refused", () => {
    const core = makeCore();
    expect(core.startUpload({ path: "/x", data: new Uint8Array(1) }, new CaptureListener()).ok).toBe(false);
    expect(core.startDownload({ path: "/x" }, new CaptureListener()).ok).toBe(false);
  });
});

// --- End to end: a real agent connection wired to a real hub core --------------------------------

const noopScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};

function wireAgentToHub(hub: HubCore, runner: FileTransferRunner): void {
  let agent: AgentConnection;
  const agentLink: AgentLink = { socketId: hub.nextSocketId(), send: (text) => agent.handleMessage(text), close() {} };
  const transport: Transport = { send: (text) => hub.onMessage(agentLink, text), close() {} };
  const deps: ConnectionDeps = {
    agentName: "hass",
    agentVersion: "0.1.0",
    capabilities: ["transfer"],
    execRunner: null,
    transferRunner: runner,
    heartbeatMs: 1_000_000_000,
    missedHeartbeatLimit: 3,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    scheduler: noopScheduler,
    log: silentLog,
  };
  agent = new AgentConnection(transport, deps);
  agent.run(); // sends the hello, which attaches the agent on the hub across the in-memory wire
}

describe("transfer end to end", () => {
  test("an upload lands on disk with verified integrity", async () => {
    const dir = tempDir();
    const path = join(dir, "landed.bin");
    const hub = makeCore();
    wireAgentToHub(hub, new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog }));

    const data = randomBytes(600_000);
    const listener = new CaptureListener();
    const result = hub.startUpload({ path, data }, listener);
    expect(result.ok).toBe(true);

    await until(() => listener.terminal() !== undefined);
    expect(listener.terminal()).toMatchObject({ kind: "completed", total: data.byteLength, checksum: checksum(data) });
    expect(sameBytes(new Uint8Array(readFileSync(path)), new Uint8Array(data))).toBe(true);
  });

  test("a download returns the file's bytes with verified integrity", async () => {
    const dir = tempDir();
    const src = join(dir, "source.bin");
    const data = randomBytes(600_000);
    writeFileSync(src, data);
    const hub = makeCore();
    wireAgentToHub(hub, new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog }));

    const listener = new CaptureListener();
    const result = hub.startDownload({ path: src }, listener);
    expect(result.ok).toBe(true);

    await until(() => listener.terminal() !== undefined);
    expect(listener.terminal()).toMatchObject({ kind: "completed", total: data.byteLength, checksum: checksum(data) });
    expect(sameBytes(listener.assembled(), new Uint8Array(data))).toBe(true);
  });
});
