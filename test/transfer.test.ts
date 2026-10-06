import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_PAYLOAD_BYTES, checksum, encodeBytes } from "../src/protocol";
import type { Logger } from "../src/agent/log";
import {
  FileTransferRunner,
  nodeTransferFs,
  type TransferFs,
  type TransferSink,
} from "../src/agent/transfer";

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

// --- Temp directories, cleaned up after each case -------------------------------------------------

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jake-transfer-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
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

  test("an upload the hub gives up on is discarded with its temp file, and answers nothing", async () => {
    const dir = tempDir();
    const path = join(dir, "out.bin");
    const data = randomBytes(300);
    const runner = new FileTransferRunner({ fs: nodeTransferFs, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, log: silentLog, chunkBytes: 64 });
    const sink = new CaptureSink();
    runner.begin({ id: "u5", direction: "upload", path, total: data.byteLength, checksum: checksum(data) }, sink);
    runner.chunk("u5", 0, encodeBytes(data.subarray(0, 100)));
    await until(() => readdirSync(dir).length === 1); // the temp file is open

    runner.cancel("u5");
    await until(() => readdirSync(dir).length === 0);
    // What the hub had already sent before it gave up finds no transfer to feed.
    runner.chunk("u5", 1, encodeBytes(data.subarray(100)));
    runner.end("u5", data.byteLength, checksum(data));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(readdirSync(dir)).toEqual([]);
    expect(sink.calls).toEqual([]);
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
