// A local, size-bounded rolling log.

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The severity of a log line. */
export type LogLevel = "info" | "warn" | "error";

/** What the connection core and the runtime write to. A test passes a capturing implementation. */
export interface Logger {
  log(level: LogLevel, event: string, detail?: Record<string, unknown>): void;
}

/** A logger that discards everything. Useful where a component needs a logger but a test ignores it. */
export const nullLogger: Logger = {
  log() {
    // discard
  },
};

/**
 * The narrow filesystem the rolling log needs. Every method names a path and does one thing, so a
 * fake can hold the files in a map and the rotation logic can be checked without a disk.
 */
export interface LogFileSystem {
  /** The size of a file in bytes, or 0 if it does not exist. */
  size(path: string): number;
  /** Append text to a file, creating it and any missing parent directory. */
  append(path: string, text: string): void;
  /** Rename a file. The destination is overwritten if it exists. */
  rename(from: string, to: string): void;
  /** Remove a file. A path that does not exist is not an error. */
  remove(path: string): void;
  /** Whether a file exists. */
  exists(path: string): boolean;
}

export interface RollingLogOptions {
  /** The largest the live file may grow before it is rotated, in bytes. */
  maxBytes: number;
  /** How many rotated files to keep beside the live one. */
  keep: number;
  /** The filesystem to write through. */
  fs: LogFileSystem;
  /** The clock, so a test can stamp lines deterministically. */
  now?: () => number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/**
 * A size-bounded append-only log. Each line is one JSON object — a timestamp, a level, an event
 * name, and whatever detail the caller passed — so the file is greppable after the fact. When the
 * live file would exceed its cap, the rotated files shift up by one, the oldest beyond `keep` is
 * dropped, the live file becomes the first rotated file, and a fresh live file takes the new line.
 */
export class RollingLog implements Logger {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly fs: LogFileSystem;
  private readonly now: () => number;

  constructor(path: string, options: RollingLogOptions) {
    this.path = path;
    this.maxBytes = options.maxBytes;
    this.keep = options.keep;
    this.fs = options.fs;
    this.now = options.now ?? Date.now;
  }

  log(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    const line = `${JSON.stringify({ t: new Date(this.now()).toISOString(), level, event, ...detail })}\n`;
    if (this.fs.size(this.path) + line.length > this.maxBytes) {
      this.rotate();
    }
    this.fs.append(this.path, line);
  }

  private rotate(): void {
    // Drop the file that would fall off the end, then shift each survivor up one slot, then the live
    // file becomes slot 1. A slot that does not exist is skipped, so a young log rotates cleanly.
    this.fs.remove(`${this.path}.${this.keep}`);
    for (let slot = this.keep - 1; slot >= 1; slot -= 1) {
      const from = `${this.path}.${slot}`;
      if (this.fs.exists(from)) {
        this.fs.rename(from, `${this.path}.${slot + 1}`);
      }
    }
    if (this.fs.exists(this.path)) {
      this.fs.rename(this.path, `${this.path}.1`);
    }
  }
}

/** Build the default logger the agent runs with: a rolling file log backed by the real disk. */
export function fileLogger(path: string, options?: Partial<Omit<RollingLogOptions, "fs">>): RollingLog {
  return new RollingLog(path, {
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
    keep: options?.keep ?? DEFAULT_KEEP,
    now: options?.now,
    fs: diskLogFileSystem(),
  });
}

/** The real filesystem, used by the agent in production. */
export function diskLogFileSystem(): LogFileSystem {
  return {
    size(p) {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    },
    append(p, text) {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, text);
    },
    rename(from, to) {
      renameSync(from, to);
    },
    remove(p) {
      try {
        rmSync(p);
      } catch {
        // not there — nothing to remove
      }
    },
    exists(p) {
      return existsSync(p);
    },
  };
}
