// Starts the hub as its own process for the contract tests, on free loopback ports.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MANIFEST = join(ROOT, "hub", "Cargo.toml");
const BINARY = join(ROOT, "target", "debug", "jake-hub");

/** The test seams the hub reads from its environment, set short so a liveness case takes milliseconds. */
export interface HubSeams {
  // The targets a stream back may reach, as JAKE_REVERSE_TARGETS names them.
  reverseTargets?: string;
  // The key scoped control credentials are made with, as JAKE_CONTROL_KEY.
  controlKey?: string;
  // The key an agent's credential of its own name is made with, as JAKE_AGENT_KEY.
  agentKey?: string;
  /** The agent and control ports to bind, so a hub started again answers where the last one did; free ones when omitted. */
  ports?: [number, number];
  pingIntervalMs?: number;
  missedPongLimit?: number;
  socketBacklogBytes?: number;
  /** The data directory the hub keeps its record in; a fresh one, removed at the stop, when omitted. */
  dataDir?: string;
  /** The agent build the hub orders agents onto, as JAKE_AGENT_BUILD_DIR names it; the orders are off when omitted. */
  agentBuildDir?: string;
}

/** The address a hub started here tells its agents to download a build from. */
export const AGENT_DOWNLOAD_URL = "https://downloads.test/jake";

/** A running hub process: its two ports, the lines it wrote to stderr, and its teardown. */
export interface HubProcess {
  agentPort: number;
  controlPort: number;
  stderr: string[];
  stop(): Promise<void>;
  /** End the process at once, with no shutdown of its own, as a crash would. */
  crash(): Promise<void>;
}

let built = false;

/** Build the hub once per test run; cargo answers at once when nothing changed. */
export function ensureHubBuilt(): void {
  if (built) return;
  const result = Bun.spawnSync(["cargo", "build", "--offline", "--quiet", "--manifest-path", MANIFEST], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("cargo build of the hub failed");
  built = true;
}

// Two ports no one holds, taken together so they differ, then released for the hub to bind.
function freePorts(): [number, number] {
  const handler = { socket: { data() {} } };
  const first = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handler });
  const second = Bun.listen({ hostname: "127.0.0.1", port: 0, ...handler });
  const ports: [number, number] = [first.port, second.port];
  first.stop(true);
  second.stop(true);
  return ports;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const piece of stream) {
    buffer += decoder.decode(piece, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
    }
  }
}

/**
 * The hub executable run with a client verb against a running hub, configured by its two ports and by
 * `credentials`: JAKE_CONTROL_TOKEN, JAKE_CONTROL_CREDENTIAL or JAKE_CONTROL_KEY, as the verb needs.
 */
export function startHubClient(
  hub: HubProcess,
  credentials: Record<string, string>,
  args: string[],
): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  ensureHubBuilt();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    JAKE_HUB_ENV: join(tmpdir(), "jake-client-no-such-file.env"),
    JAKE_HUB_HOST: "127.0.0.1",
    JAKE_HUB_PORT: String(hub.agentPort),
    JAKE_CONTROL_PORT: String(hub.controlPort),
    ...credentials,
  };
  return Bun.spawn([BINARY, ...args], { cwd: ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** Start a hub with the given secret and control token, returning once it says it is listening. */
export async function startHubProcess(secret: string, controlToken: string, seams: HubSeams = {}): Promise<HubProcess> {
  ensureHubBuilt();
  const [agentPort, controlPort] = seams.ports ?? freePorts();
  const dataDir = seams.dataDir ?? mkdtempSync(join(tmpdir(), "jake-hub-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // No file is read: the test's environment is the whole configuration.
    JAKE_HUB_ENV: join(dataDir, "hub.env"),
    JAKE_HUB_HOST: "127.0.0.1",
    JAKE_HUB_PORT: String(agentPort),
    JAKE_CONTROL_PORT: String(controlPort),
    JAKE_SECRET: secret,
    JAKE_CONTROL_TOKEN: controlToken,
  };
  if (seams.pingIntervalMs !== undefined) env.JAKE_HUB_PING_INTERVAL_MS = String(seams.pingIntervalMs);
  if (seams.missedPongLimit !== undefined) env.JAKE_HUB_MISSED_PONG_LIMIT = String(seams.missedPongLimit);
  if (seams.socketBacklogBytes !== undefined) env.JAKE_HUB_SOCKET_BACKLOG_BYTES = String(seams.socketBacklogBytes);
  if (seams.reverseTargets !== undefined) env.JAKE_REVERSE_TARGETS = seams.reverseTargets;
  if (seams.controlKey !== undefined) env.JAKE_CONTROL_KEY = seams.controlKey;
  if (seams.agentKey !== undefined) env.JAKE_AGENT_KEY = seams.agentKey;
  if (seams.agentBuildDir === undefined) env.JAKE_AGENT_UPDATE = "off";
  else env.JAKE_AGENT_BUILD_DIR = seams.agentBuildDir;
  env.JAKE_AGENT_DOWNLOAD_URL = AGENT_DOWNLOAD_URL;

  const child = Bun.spawn([BINARY], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stderr: string[] = [];
  void (async () => {
    for await (const line of lines(child.stderr)) stderr.push(line);
  })();

  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await child.exited;
    clearTimeout(timer);
    if (seams.dataDir === undefined) rmSync(dataDir, { recursive: true, force: true });
  };

  const crash = async (): Promise<void> => {
    child.kill("SIGKILL");
    await child.exited;
  };

  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  for await (const line of lines(child.stdout)) {
    if (line.startsWith("jake hub: agent server on")) {
      clearTimeout(timer);
      return { agentPort, controlPort, stderr, stop, crash };
    }
  }
  clearTimeout(timer);
  await stop();
  throw new Error(`the hub did not start: ${stderr.join("\n")}`);
}
