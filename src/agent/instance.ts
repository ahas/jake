// The single-instance guard. Each binary is anchored three ways — a Run value, a Startup shortcut,
// and a scheduled task — and all three fire at the same logon, so without a guard one logon would
// start three copies of the same process, and a watchdog pair that multiplies itself is not staying
// alive but multiplying. The guard lets exactly one copy of a binary run: the first to take the lock
// proceeds, and a later copy that finds a live holder exits.
//
// The lock is a file created atomically — the OS lets exactly one exclusive create win, so even the
// near-simultaneous copies a logon fires cannot both take it. The file holds the holder's pid, so a
// lock left behind by a crashed process (its pid no longer alive) is reclaimed rather than blocking
// the binary forever. The filesystem and the liveness check are seams, so every case is driven on
// this machine by fakes. docs/architecture.md is the canonical statement of the staying-alive scheme.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The narrow filesystem the lock needs. `createExclusive` must fail when the path already exists —
 * that atomicity is what makes the lock a lock — and succeed otherwise. `read` returns null for a
 * missing file; `remove` treats a missing file as done.
 */
export interface LockFs {
  /** Atomically create the file with `text`, failing if it already exists. */
  createExclusive(path: string, text: string): boolean;
  /** The file's text, or null if it does not exist. */
  read(path: string): string | null;
  /** Remove the file. A path that does not exist is not an error. */
  remove(path: string): void;
}

/** The real filesystem for the lock, used on 하스's box. Exclusive create is the `wx` open flag. */
export function diskLockFs(): LockFs {
  return {
    createExclusive(path, text) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    remove(path) {
      try {
        rmSync(path);
      } catch {
        // not there — nothing to remove
      }
    },
  };
}

/** Whether a process id is still running. The real check needs no spawn; a test passes a fake. */
export type PidAlive = (pid: number) => boolean;

/**
 * The real liveness check: signal 0 tests for a process without touching it. A missing process
 * raises ESRCH (dead); EPERM means it exists but is not ours to signal (alive). Anything else is
 * treated as alive, so the guard errs toward not stealing a lock it is unsure about.
 */
export const systemPidAlive: PidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What acquiring the lock needs: the path, this process's pid, and the two seams. */
export interface InstanceLockOptions {
  path: string;
  pid: number;
  fs: LockFs;
  pidAlive: PidAlive;
}

/**
 * Try to become the single running instance. Returns true when this process took the lock and should
 * run, false when a live holder already has it and this copy should exit. A lock left by a crashed
 * process — one whose pid is no longer alive — is reclaimed: it is removed and the create retried
 * once. The retry is bounded so two copies racing over a stale lock cannot loop.
 */
export function acquireInstanceLock(options: InstanceLockOptions): boolean {
  const { path, pid, fs, pidAlive } = options;
  if (fs.createExclusive(path, String(pid))) {
    return true;
  }
  // The lock exists. If its holder is alive, this copy must step aside; if it is a corpse, reclaim it.
  const raw = fs.read(path);
  const holder = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
  if (!Number.isNaN(holder) && pidAlive(holder)) {
    return false;
  }
  fs.remove(path);
  return fs.createExclusive(path, String(pid));
}

/** Release the lock this process holds. Called on a clean exit; a crash leaves it for the pid check. */
export function releaseInstanceLock(path: string, fs: LockFs): void {
  fs.remove(path);
}
