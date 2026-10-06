// The console's config, read from the hub's own environment file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A source of configuration values. process.env satisfies it; tests pass a plain object. */
export type Env = Record<string, string | undefined>;

// The control API's port when the hub's file does not name one. The token has no default: a console
// that cannot find it must stop, not call the hub with a guessed value.
const DEFAULT_CONTROL_PORT = 8791;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy the matching .env.example and fill it in.`);
  }
  return value;
}

function optionalIntEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function optionalPositiveIntEnv(env: Env, name: string, fallback: number): number {
  const value = optionalIntEnv(env, name, fallback);
  if (value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

/** What the operator console needs to reach the hub's loopback control API. */
export interface ConsoleConfig {
  /** The port the loopback control API listens on. */
  controlPort: number;
  /** The token every control-API request carries. Read from the hub's config, not a flag. */
  controlToken: string;
}

/**
 * Read the console's configuration from an environment source. The console reads the same keys the
 * hub does — it is pointed at the hub's own environment file — but needs only the control port and
 * token; the agent secret and the bind address are the hub's concern, not the console's.
 */
export function loadConsoleConfig(env: Env = process.env): ConsoleConfig {
  return {
    controlPort: optionalPositiveIntEnv(env, "JAKE_CONTROL_PORT", DEFAULT_CONTROL_PORT),
    controlToken: requireEnv(env, "JAKE_CONTROL_TOKEN"),
  };
}

/**
 * Parse the text of a `.env` file into an environment record. Lines are `KEY=value`; blank lines
 * and `#` comments are skipped, surrounding whitespace on the key is trimmed, and a value may be
 * wrapped in single or double quotes to keep leading or trailing spaces. This is the "single file
 * per side" the config is read from when the runtime does not populate the environment itself.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read and parse a `.env` file from disk into an environment record. */
export function loadEnvFile(path: string): Record<string, string> {
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** Where the hub keeps its configuration when nothing overrides it — a single file under the data
 * directory, outside the git tree, the same place the console reads it from. */
export function hubEnvPath(env: Env = process.env): string {
  return env.JAKE_HUB_ENV ?? join(homedir(), ".local", "share", "jake", "hub.env");
}

/**
 * The environment the hub and the console run against. Both read the same single file — `hub.env`
 * under the data directory — so the two sides of the loopback control API agree on where the token
 * lives. Its values sit under the real process environment, so a variable set explicitly still
 * overrides the file, and JAKE_HUB_ENV points the resolution at another file for a local test. When
 * neither the override nor the default file exists — a plain `bun` run with the environment already
 * populated — the process environment stands alone.
 */
export function hubFileEnv(env: Env = process.env): Env {
  const path = hubEnvPath(env);
  if (existsSync(path)) {
    return { ...loadEnvFile(path), ...env };
  }
  return env;
}
