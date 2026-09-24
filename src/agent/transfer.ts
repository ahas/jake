// The file-transfer capability: moving a file across the tunnel over its own frames.

import { createHash, randomBytes } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CHECKSUM_ALGORITHM,
  TRANSFER_CHUNK_BYTES,
  decodeBytes,
  type EncodedBytes,
  type TransferDirection,
} from "../protocol";
import type { Logger } from "./log";

/** The begin frame's fields, as the connection hands them to the runner. */
export interface TransferBeginRequest {
  id: string;
  direction: TransferDirection;
  path: string;
  /** The declared byte total, present on an upload's begin and null on a download request. */
  total: number | null;
  /** The declared content checksum, present on an upload's begin and null on a download request. */
  checksum: string | null;
}

/**
 * Where a transfer's outbound frames go. The connection owns the wire: it closes over the transfer's
 * id, direction, and path and turns each call into a frame. A download answers a request with `begin`,
 * then a run of `chunk`, then `end`; an upload reports only its terminal event — `end` as the success
 * acknowledgement, or `fail` for a mismatch or a file-system error.
 */
export interface TransferSink {
  begin(total: number, checksum: string): void;
  chunk(seq: number, bytes: Uint8Array): void;
  end(total: number, checksum: string): void;
  fail(code: string, message: string): void;
}

/**
 * The component that serves a file transfer. `begin` opens one — an upload it receives, or a download
 * it answers; `chunk` and `end` feed an upload in progress; `cancel` discards the one transfer the hub
 * gave up on, and `abandon` every transfer still open when the socket drops, so no temporary file is
 * left behind.
 */
export interface TransferRunner {
  /** The capability names this runner contributes to the hello list. */
  readonly capabilities: readonly string[];
  begin(request: TransferBeginRequest, sink: TransferSink): void;
  chunk(id: string, seq: number, chunk: EncodedBytes): void;
  end(id: string, total: number, checksum: string): void;
  cancel(id: string): void;
  abandon(): void;
}

/** The capability name a transfer runner contributes to the hello list. */
export const TRANSFER_CAPABILITY = "transfer";

// --- The file-system seam ------------------------------------------------------------------------

/** One open file being written for an upload: bytes appended in order, then closed. */
export interface TransferWrite {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** One open file being read for a download: chunks yielded until end of file, then closed. */
export interface TransferRead {
  next(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

/**
 * The file operations the runner needs, injected so its integrity and error handling are driven by a
 * fake that can raise a permission or disk-full failure on demand. The production implementation is
 * `nodeTransferFs`.
 */
export interface TransferFs {
  /** A temporary path beside `target`, unique to this transfer, for streaming before the atomic move. */
  tempPath(target: string, id: string): string;
  /** Open a file for writing, truncating any existing content. */
  createWrite(path: string): Promise<TransferWrite>;
  /** The byte size of a file; rejects if it cannot be read or names a directory. */
  size(path: string): Promise<number>;
  /** Open a file for reading, yielding chunks of at most `chunkBytes`. */
  createRead(path: string, chunkBytes: number): Promise<TransferRead>;
  /** Move a file into place atomically, over any existing one. */
  move(from: string, to: string): Promise<void>;
  /** Remove a file, ignoring a missing one. */
  remove(path: string): Promise<void>;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "") || "x";
}

/** The production file-system seam, over node's promise-based fs. */
export const nodeTransferFs: TransferFs = {
  tempPath(target, id) {
    return join(dirname(target), `.jake-${sanitizeId(id)}-${randomBytes(6).toString("hex")}.part`);
  },
  async createWrite(path) {
    const handle = await open(path, "w");
    return {
      async write(bytes) {
        await handle.write(bytes);
      },
      async close() {
        await handle.close();
      },
    };
  },
  async size(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      const error = new Error(`${path} is a directory`) as NodeJS.ErrnoException;
      error.code = "EISDIR";
      throw error;
    }
    return info.size;
  },
  async createRead(path, chunkBytes) {
    const handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    return {
      async next() {
        const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
        if (bytesRead === 0) {
          return null;
        }
        // Copy out of the reused buffer, so a chunk kept past the next read is still its own bytes.
        return Uint8Array.from(buffer.subarray(0, bytesRead));
      },
      async close() {
        await handle.close();
      },
    };
  },
  async move(from, to) {
    await rename(from, to);
  },
  async remove(path) {
    await rm(path, { force: true });
  },
};

// --- The runner ----------------------------------------------------------------------------------

/** What the transfer runner needs: the file-system seam, the payload cap, the chunk size, and a log. */
export interface FileTransferRunnerOptions {
  fs: TransferFs;
  /** The largest declared chunk payload this side will decode, in bytes. */
  maxPayloadBytes: number;
  log: Logger;
  /** The size a download's chunks are read and sent at. Defaults to the protocol's fixed chunk size. */
  chunkBytes?: number;
}

// An upload being assembled to a temporary path. The write handle opens asynchronously, so writes are
// serialized behind a promise chain that also carries the open; the hash and byte count advance in
// call order, which the sequence check has already proven is send order.
interface Upload {
  kind: "upload";
  sink: TransferSink;
  path: string;
  temp: string;
  write: TransferWrite | null;
  hash: ReturnType<typeof createHash>;
  received: number;
  expectedSeq: number;
  chain: Promise<void>;
  done: boolean;
}

// A download being streamed out. It carries only a flag the read loop checks, so a dropped socket
// stops it between chunks rather than streaming a whole file into a socket that is gone.
interface Download {
  kind: "download";
  canceled: boolean;
}

type Active = Upload | Download;

export class FileTransferRunner implements TransferRunner {
  readonly capabilities: readonly string[] = [TRANSFER_CAPABILITY];

  private readonly fs: TransferFs;
  private readonly maxPayloadBytes: number;
  private readonly chunkBytes: number;
  private readonly log: Logger;
  private readonly active = new Map<string, Active>();

  constructor(options: FileTransferRunnerOptions) {
    this.fs = options.fs;
    this.maxPayloadBytes = options.maxPayloadBytes;
    this.chunkBytes = options.chunkBytes ?? TRANSFER_CHUNK_BYTES;
    this.log = options.log;
  }

  begin(request: TransferBeginRequest, sink: TransferSink): void {
    if (this.active.has(request.id)) {
      sink.fail("duplicate", "a transfer with this id is already in progress");
      return;
    }
    if (request.direction === "upload") {
      this.beginUpload(request, sink);
    } else {
      void this.runDownload(request, sink);
    }
  }

  chunk(id: string, seq: number, chunk: EncodedBytes): void {
    const transfer = this.active.get(id);
    if (transfer === undefined || transfer.kind !== "upload" || transfer.done) {
      return;
    }
    if (seq !== transfer.expectedSeq) {
      this.failUpload(id, transfer, "out-of-order", `expected chunk ${transfer.expectedSeq}, got ${seq}`);
      return;
    }
    const decoded = decodeBytes(chunk, { maxPayloadBytes: this.maxPayloadBytes });
    if (!decoded.ok) {
      this.failUpload(id, transfer, "bad-chunk", decoded.error.message);
      return;
    }
    transfer.expectedSeq += 1;
    transfer.hash.update(decoded.data);
    transfer.received += decoded.data.byteLength;
    const bytes = decoded.data;
    this.enqueue(id, transfer, async () => {
      if (transfer.write === null) {
        throw new Error("the upload's temp file is not open");
      }
      await transfer.write.write(bytes);
    });
  }

  end(id: string, total: number, checksum: string): void {
    const transfer = this.active.get(id);
    if (transfer === undefined || transfer.kind !== "upload" || transfer.done) {
      return;
    }
    this.enqueue(id, transfer, async () => {
      if (transfer.done) {
        return;
      }
      if (transfer.write !== null) {
        await transfer.write.close();
        transfer.write = null;
      }
      if (transfer.received !== total || transfer.hash.digest("hex") !== checksum) {
        transfer.done = true;
        this.active.delete(id);
        await this.fs.remove(transfer.temp);
        transfer.sink.fail("integrity", `assembled ${transfer.received} bytes did not match the declared transfer`);
        return;
      }
      await this.fs.move(transfer.temp, transfer.path);
      transfer.done = true;
      this.active.delete(id);
      transfer.sink.end(total, checksum);
    });
  }

  cancel(id: string): void {
    const transfer = this.active.get(id);
    if (transfer !== undefined) {
      this.discard(id, transfer);
      this.active.delete(id);
    }
  }

  abandon(): void {
    for (const [id, transfer] of this.active) {
      this.discard(id, transfer);
    }
    this.active.clear();
  }

  // Stop one transfer without answering for it: the hub has given it up, or the socket is gone.
  private discard(id: string, transfer: Active): void {
    if (transfer.kind === "download") {
      transfer.canceled = true;
    } else if (!transfer.done) {
      transfer.done = true;
      // Best effort: close a half-open handle and drop the temp. Nothing awaits this and nothing is
      // sent, since nobody is waiting on this transfer any more.
      void transfer.chain
        .then(async () => {
          if (transfer.write !== null) {
            await transfer.write.close();
          }
          await this.fs.remove(transfer.temp);
        })
        .catch((error) => this.log.log("warn", "transfer-abandon-threw", { id, error: message(error) }));
    }
  }

  // --- Upload internals -------------------------------------------------------------------------

  private beginUpload(request: TransferBeginRequest, sink: TransferSink): void {
    const upload: Upload = {
      kind: "upload",
      sink,
      path: request.path,
      temp: this.fs.tempPath(request.path, request.id),
      write: null,
      hash: createHash(CHECKSUM_ALGORITHM),
      received: 0,
      expectedSeq: 0,
      chain: Promise.resolve(),
      done: false,
    };
    this.active.set(request.id, upload);
    this.enqueue(request.id, upload, async () => {
      upload.write = await this.fs.createWrite(upload.temp);
    });
  }

  // Append one step to an upload's serialized chain. A step that throws fails the whole transfer once;
  // later steps see the transfer done and return without running.
  private enqueue(id: string, upload: Upload, step: () => Promise<void>): void {
    upload.chain = upload.chain
      .then(async () => {
        if (upload.done) {
          return;
        }
        await step();
      })
      .catch((error) => this.failUpload(id, upload, fsErrorCode(error), message(error)));
  }

  private failUpload(id: string, upload: Upload, code: string, detail: string): void {
    if (upload.done) {
      return;
    }
    upload.done = true;
    this.active.delete(id);
    void (async () => {
      try {
        if (upload.write !== null) {
          await upload.write.close();
          upload.write = null;
        }
        await this.fs.remove(upload.temp);
      } catch (error) {
        this.log.log("warn", "transfer-cleanup-threw", { id, error: message(error) });
      }
      upload.sink.fail(code, detail);
    })();
  }

  // --- Download internals -----------------------------------------------------------------------

  private async runDownload(request: TransferBeginRequest, sink: TransferSink): Promise<void> {
    const download: Download = { kind: "download", canceled: false };
    this.active.set(request.id, download);
    try {
      const total = await this.fs.size(request.path);

      // First pass: hash the whole file, so the begin the agent answers with carries the checksum the
      // receiver will verify. A file that changes between the passes is caught by that same check.
      const hasher = createHash(CHECKSUM_ALGORITHM);
      await this.eachChunk(request.path, download, (bytes) => hasher.update(bytes));
      if (download.canceled) {
        return;
      }
      const sum = hasher.digest("hex");
      sink.begin(total, sum);

      // Second pass: stream the bytes as chunk frames, in sequence order.
      let seq = 0;
      await this.eachChunk(request.path, download, (bytes) => sink.chunk(seq++, bytes));
      if (download.canceled) {
        return;
      }
      sink.end(total, sum);
    } catch (error) {
      if (!download.canceled) {
        sink.fail(fsErrorCode(error), message(error));
      }
    } finally {
      this.active.delete(request.id);
    }
  }

  private async eachChunk(path: string, download: Download, onChunk: (bytes: Uint8Array) => void): Promise<void> {
    const reader = await this.fs.createRead(path, this.chunkBytes);
    try {
      for (;;) {
        if (download.canceled) {
          return;
        }
        const bytes = await reader.next();
        if (bytes === null) {
          return;
        }
        onChunk(bytes);
      }
    } finally {
      await reader.close();
    }
  }
}

/** Map a file-system error to a transfer error code, naming the cases 하스 cares to see distinctly. */
export function fsErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "ENOENT":
      return "not-found";
    case "EACCES":
    case "EPERM":
      return "permission";
    case "ENOSPC":
      return "disk-full";
    case "EISDIR":
      return "is-directory";
    default:
      return "fs-error";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
