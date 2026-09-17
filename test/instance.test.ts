import { describe, expect, test } from "bun:test";

import {
  acquireInstanceLock,
  releaseInstanceLock,
  type LockFs,
  type PidAlive,
} from "../src/agent/instance";

// A lock filesystem whose exclusive create honours the atomicity the real one relies on: a second
// create of an existing path fails.
class FakeLockFs implements LockFs {
  readonly files = new Map<string, string>();
  createExclusive(path: string, text: string): boolean {
    if (this.files.has(path)) {
      return false;
    }
    this.files.set(path, text);
    return true;
  }
  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }
  remove(path: string): void {
    this.files.delete(path);
  }
}

const LOCK = "/data/agent.lock";
const aliveNone: PidAlive = () => false;
const aliveAll: PidAlive = () => true;

describe("acquireInstanceLock", () => {
  test("the first copy takes the lock and records its pid", () => {
    const fs = new FakeLockFs();
    expect(acquireInstanceLock({ path: LOCK, pid: 111, fs, pidAlive: aliveNone })).toBe(true);
    expect(fs.files.get(LOCK)).toBe("111");
  });

  test("a second copy steps aside while the live holder keeps the lock", () => {
    const fs = new FakeLockFs();
    acquireInstanceLock({ path: LOCK, pid: 111, fs, pidAlive: aliveAll });
    expect(acquireInstanceLock({ path: LOCK, pid: 222, fs, pidAlive: aliveAll })).toBe(false);
    expect(fs.files.get(LOCK)).toBe("111"); // the live holder is not displaced
  });

  test("reclaims a lock left by a crashed holder", () => {
    const fs = new FakeLockFs();
    fs.files.set(LOCK, "999"); // a corpse's lock
    const alive: PidAlive = (pid) => pid !== 999;
    expect(acquireInstanceLock({ path: LOCK, pid: 222, fs, pidAlive: alive })).toBe(true);
    expect(fs.files.get(LOCK)).toBe("222");
  });

  test("reclaims a lock whose holder pid cannot be parsed", () => {
    const fs = new FakeLockFs();
    fs.files.set(LOCK, "garbage");
    expect(acquireInstanceLock({ path: LOCK, pid: 222, fs, pidAlive: aliveAll })).toBe(true);
    expect(fs.files.get(LOCK)).toBe("222");
  });

  test("two crashed copies racing over a stale lock: exactly one wins the reclaim", () => {
    // The reclaim removes then re-creates exclusively; if a rival re-created it first, the create
    // fails and this copy steps aside rather than looping.
    const fs = new FakeLockFs();
    fs.files.set(LOCK, "999");
    const alive: PidAlive = (pid) => pid !== 999;
    // First reclaimer wins.
    expect(acquireInstanceLock({ path: LOCK, pid: 1, fs, pidAlive: alive })).toBe(true);
    // A later copy now finds pid 1 alive and steps aside.
    expect(acquireInstanceLock({ path: LOCK, pid: 2, fs, pidAlive: (pid) => pid === 1 })).toBe(false);
  });
});

describe("releaseInstanceLock", () => {
  test("removes the lock so the next copy can take it", () => {
    const fs = new FakeLockFs();
    acquireInstanceLock({ path: LOCK, pid: 111, fs, pidAlive: aliveNone });
    releaseInstanceLock(LOCK, fs);
    expect(fs.files.has(LOCK)).toBe(false);
    expect(acquireInstanceLock({ path: LOCK, pid: 222, fs, pidAlive: aliveNone })).toBe(true);
  });
});
