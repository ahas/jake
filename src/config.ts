// The config each side reads at startup. Nothing here is compiled into a binary: the agent and the
// hub each read a single environment file — the agent's beside its exe, the hub's under its data
// directory, outside the git tree, exactly as BMO keeps its own. The repo carries only the example
// files. A missing or malformed key is reported by name and stops the process; a credential never
// falls back to a built-in default.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A source of configuration values. process.env satisfies it; tests pass a plain object. */
export type Env = Record<string, string | undefined>;

/** What the Windows-side agent needs to dial the hub and keep itself alive. */
export interface AgentConfig {
  /** The hub URL the agent dials out to (wss:// through the public name, ws:// on the LAN). */
  hubUrl: string;
  /** The shared secret sent as a Bearer credential at the WebSocket upgrade. */
  secret: string;
  /** This agent's identity. The hub expects exactly one; a duplicate supersedes the first. */
  agentName: string;
  /** How often the agent sends a ping and refreshes its liveness, in milliseconds. */
  heartbeatMs: number;
  /** How often the self-healing pair rewrites its autostart anchors, in milliseconds. */
  tickMs: number;
  /** How old a peer's heartbeat may grow before the watchdog treats it as dead, in milliseconds. */
  watchdogStaleMs: number;
  /** The largest single frame payload the agent will encode or accept, in bytes. */
  maxPayloadBytes: number;
  /** The most output one exec command may stream before jake stops it, in bytes. */
  execMaxOutputBytes: number;
  /** The wall-clock ceiling on a single exec command before jake stops it, in milliseconds. */
  execTimeoutMs: number;
  /** The largest response body the fetch capability will return, in bytes. */
  fetchMaxBodyBytes: number;
  /** How many redirects the fetch capability follows before it refuses to go further. */
  fetchMaxRedirects: number;
  /** An explicit path to the browser sidecar directory, or null to look for it beside the exe. */
  browserSidecarDir: string | null;
  /** How long the browser sidecar may sit idle before it is shut down, in milliseconds. */
  browserIdleMs: number;
  /** The wall-clock ceiling on one browser call before it is failed, in milliseconds. */
  browserCallTimeoutMs: number;
}

/** What the main-host-side hub needs to accept the agent and to be driven by the console. */
export interface HubConfig {
  /** The address the agent-facing WebSocket server binds to. */
  host: string;
  /** The port the agent-facing WebSocket server listens on. */
  port: number;
  /** The shared secret an agent must present. Must match the agent's secret. */
  secret: string;
  /** The port the loopback control API listens on, bound to 127.0.0.1 alone. */
  controlPort: number;
  /** The token every control-API request carries. Distinct from the agent secret. */
  controlToken: string;
  /** The largest single frame payload the hub will accept from the agent, in bytes. */
  maxPayloadBytes: number;
}

// Defaults for the non-credential knobs. Credentials and the hub URL have no default: a process
// that cannot find them must stop, not run against a guessed value.
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_TICK_MS = 60_000;
// Three ticks at the default tick: a peer is declared dead only after it has missed three
// consecutive heartbeat writes, so one slow or paused tick does not trigger a false relaunch, while
// a genuine death or hang is caught within about three minutes.
const DEFAULT_WATCHDOG_STALE_MS = 180_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_FETCH_MAX_REDIRECTS = 5;
const DEFAULT_BROWSER_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_BROWSER_CALL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_HUB_HOST = "0.0.0.0";
const DEFAULT_HUB_PORT = 8790;
const DEFAULT_CONTROL_PORT = 8791;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy the matching .env.example and fill it in.`);
  }
  return value;
}

function requireIntEnv(env: Env, name: string): number {
  const raw = requireEnv(env, name);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be an integer.`);
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

function optionalNonNegativeIntEnv(env: Env, name: string, fallback: number): number {
  const value = optionalIntEnv(env, name, fallback);
  if (value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function optionalStringEnv(env: Env, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw === "" ? null : raw;
}

/** Read the agent's configuration from an environment source. */
export function loadAgentConfig(env: Env = process.env): AgentConfig {
  return {
    hubUrl: requireEnv(env, "JAKE_HUB_URL"),
    secret: requireEnv(env, "JAKE_SECRET"),
    agentName: requireEnv(env, "JAKE_AGENT_NAME"),
    heartbeatMs: optionalPositiveIntEnv(env, "JAKE_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
    tickMs: optionalPositiveIntEnv(env, "JAKE_TICK_MS", DEFAULT_TICK_MS),
    watchdogStaleMs: optionalPositiveIntEnv(env, "JAKE_WATCHDOG_STALE_MS", DEFAULT_WATCHDOG_STALE_MS),
    maxPayloadBytes: optionalPositiveIntEnv(env, "JAKE_MAX_PAYLOAD_BYTES", DEFAULT_MAX_PAYLOAD_BYTES),
    execMaxOutputBytes: optionalPositiveIntEnv(env, "JAKE_EXEC_MAX_OUTPUT_BYTES", DEFAULT_EXEC_MAX_OUTPUT_BYTES),
    execTimeoutMs: optionalPositiveIntEnv(env, "JAKE_EXEC_TIMEOUT_MS", DEFAULT_EXEC_TIMEOUT_MS),
    fetchMaxBodyBytes: optionalPositiveIntEnv(env, "JAKE_FETCH_MAX_BODY_BYTES", DEFAULT_FETCH_MAX_BODY_BYTES),
    fetchMaxRedirects: optionalNonNegativeIntEnv(env, "JAKE_FETCH_MAX_REDIRECTS", DEFAULT_FETCH_MAX_REDIRECTS),
    browserSidecarDir: optionalStringEnv(env, "JAKE_BROWSER_SIDECAR_DIR"),
    browserIdleMs: optionalPositiveIntEnv(env, "JAKE_BROWSER_IDLE_MS", DEFAULT_BROWSER_IDLE_MS),
    browserCallTimeoutMs: optionalPositiveIntEnv(env, "JAKE_BROWSER_CALL_TIMEOUT_MS", DEFAULT_BROWSER_CALL_TIMEOUT_MS),
  };
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

/** Read the hub's configuration from an environment source. */
export function loadHubConfig(env: Env = process.env): HubConfig {
  return {
    host: env.JAKE_HUB_HOST === undefined || env.JAKE_HUB_HOST === "" ? DEFAULT_HUB_HOST : env.JAKE_HUB_HOST,
    port: optionalPositiveIntEnv(env, "JAKE_HUB_PORT", DEFAULT_HUB_PORT),
    secret: requireEnv(env, "JAKE_SECRET"),
    controlPort: optionalPositiveIntEnv(env, "JAKE_CONTROL_PORT", DEFAULT_CONTROL_PORT),
    controlToken: requireEnv(env, "JAKE_CONTROL_TOKEN"),
    maxPayloadBytes: optionalPositiveIntEnv(env, "JAKE_MAX_PAYLOAD_BYTES", DEFAULT_MAX_PAYLOAD_BYTES),
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

/**
 * The environment the agent and guard binaries run against. The installer writes the real
 * configuration to `agent.env` beside the executable — the anchors launch the exe with no
 * environment of their own — so both binaries read that file at startup. Its values sit under the
 * real process environment, so a variable set explicitly in the environment still overrides the
 * file. When no file is beside the exe — a plain `bun` run in development — the process environment
 * stands alone.
 */
export function agentFileEnv(exeDir: string, env: Env = process.env): Env {
  const path = join(exeDir, "agent.env");
  if (existsSync(path)) {
    return { ...loadEnvFile(path), ...env };
  }
  return env;
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
 * populated — the process environment stands alone. This mirrors how the agent reads its own file
 * beside its executable; each side owns the file it reads.
 */
export function hubFileEnv(env: Env = process.env): Env {
  const path = hubEnvPath(env);
  if (existsSync(path)) {
    return { ...loadEnvFile(path), ...env };
  }
  return env;
}
