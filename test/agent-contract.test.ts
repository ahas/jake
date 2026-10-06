import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_COMMAND, ensureAgentBuilt, StandInHub, startAgentProcess, until, type AgentProcess, type HubConnection, type WireFrame } from "./agent-process";

const SECRET = "contract-secret";
const CHUNK = 256 * 1024;

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jake-agent-"));
  scratch.push(dir);
  return dir;
}

const hubs: StandInHub[] = [];
const agents: AgentProcess[] = [];

// A build after a change takes far longer than one case may, so the agent is built before any.
beforeAll(ensureAgentBuilt, 600_000);

afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.stop()));
  for (const hub of hubs) hub.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function standInHub(): StandInHub {
  const hub = new StandInHub(SECRET);
  hubs.push(hub);
  return hub;
}

function agent(hubUrl: string, env: Record<string, string> = {}, home = tempDir(), secret = SECRET): AgentProcess {
  const started = startAgentProcess({ hubUrl, secret, name: "box", home, env: { JAKE_REDIAL_BASE_MS: "20", ...env } });
  agents.push(started);
  return started;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function bytesOf(frame: WireFrame): Buffer {
  return Buffer.from((frame.chunk as { base64: string }).base64, "base64");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A run's frames gathered until it ends: its output by stream, and the exit or error that ended it. */
interface Run {
  stdout: string;
  stderr: string;
  end: WireFrame;
  output: WireFrame[];
}

let nextId = 0;

async function run(connection: HubConnection, command: string, extra: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<Run> {
  const id = `r${nextId++}`;
  connection.send({ type: "exec", id, shell: "linux", command, cwd: null, env: {}, distro: null, ...extra });
  const end = await connection.next((f) => f.id === id && (f.type === "exit" || f.type === "error"), `the end of ${id}`, timeoutMs);
  const output = connection.all((f) => f.id === id && (f.type === "stdout" || f.type === "stderr"));
  const text = (kind: string) =>
    Buffer.concat(output.filter((f) => f.type === kind).map(bytesOf)).toString("utf8");
  return { stdout: text("stdout"), stderr: text("stderr"), end, output };
}

describe("the handshake and the connection", () => {
  let hub: StandInHub;
  let process_: AgentProcess;
  let first: HubConnection;

  beforeAll(async () => {
    hub = standInHub();
    process_ = agent(hub.url, { JAKE_HEARTBEAT_MS: "100" });
    first = await hub.welcomed(0);
  });

  test("dials with the shared secret and says hello with its name, version and this host's shells", () => {
    const hello = first.frames[0] as WireFrame;
    expect(hello).toMatchObject({ type: "hello", v: 1, agent: "box", capabilities: ["exec:linux", "transfer"] });
    expect(typeof hello.agentVersion).toBe("string");
    expect(hello.agentVersion).not.toBe("");
  });

  test("records the welcome in its local log, where the installer looks for it", async () => {
    await until("the welcomed event", () => process_.log().some((line) => line.event === "welcomed"));
  });

  test("answers a ping with a pong echoing the clock, and pings on its own interval", async () => {
    first.send({ type: "ping", ts: 4242 });
    await first.next((f) => f.type === "pong" && f.ts === 4242, "the pong");
    await first.next((f) => f.type === "ping" && typeof f.ts === "number", "the agent's own ping");
  });

  test("ignores a frame it cannot read and keeps the connection", async () => {
    first.sendRaw("not json");
    first.send({ type: "call", id: "x" });
    first.send({ type: "ping", ts: 7 });
    await first.next((f) => f.type === "pong" && f.ts === 7, "the pong after the noise");
    expect(first.closed).toBe(false);
  });

  test("drops a hub that falls silent past the liveness window and dials again", async () => {
    // From here the hub answers nothing, so only the agent's own pings cross.
    await until("the silent socket to close", () => first.closed, 3_000);
    const second = await hub.connection(1);
    expect(second.frames[0]).toMatchObject({ type: "hello", agent: "box" });
  });

  test("a reject ends the connection, is logged as rejected, and the agent dials again", async () => {
    const second = hub.connections[1] as HubConnection;
    second.send({ type: "reject", reason: "name taken" });
    await until("the rejected socket to close", () => second.closed);
    await hub.connection(2);
    expect(process_.log().some((line) => line.event === "rejected" && line.reason === "name taken")).toBe(true);
  });

  test("a socket the hub closes is dialed again", async () => {
    const third = await hub.welcomed(2);
    third.close();
    await hub.connection(3);
  });
});

/** A private root and a certificate for 127.0.0.1 signed by it, as PEM files under `dir`. */
function privateRoot(dir: string): { root: string; cert: string; key: string } {
  const openssl = (...args: string[]) => {
    const result = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${result.stderr.toString()}`);
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  openssl("req", "-x509", ...ec, "-keyout", "root.key", "-out", "root.pem", "-subj", "/CN=test root", "-days", "1");
  openssl("req", ...ec, "-keyout", "hub.key", "-out", "hub.csr", "-subj", "/CN=127.0.0.1");
  writeFileSync(join(dir, "hub.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  openssl("x509", "-req", "-in", "hub.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "hub.pem", "-days", "1", "-extfile", "hub.ext");
  return { root: join(dir, "root.pem"), cert: readFileSync(join(dir, "hub.pem"), "utf8"), key: readFileSync(join(dir, "hub.key"), "utf8") };
}

describe("a hub over TLS", () => {
  test("is trusted through the machine's own trust store, where a network that inspects TLS puts its root", async () => {
    const pki = privateRoot(tempDir());
    const hub = new StandInHub(SECRET, { cert: pki.cert, key: pki.key });
    hubs.push(hub);
    agent(hub.url, { SSL_CERT_FILE: pki.root });
    expect((await hub.connection(0)).frames[0]).toMatchObject({ type: "hello", agent: "box" });
  });
});

describe("a dial that does not open", () => {
  test("a refused secret is logged as rejected, and a hub that does not answer as dial-failed", async () => {
    const hub = standInHub();
    const refused = agent(hub.url, {}, tempDir(), "wrong-secret");
    await until("the rejected event", () => refused.log().some((line) => line.event === "rejected" && line.status === 401));

    const nowhere = agent("ws://127.0.0.1:9");
    await until("the dial-failed event", () => nowhere.log().some((line) => line.event === "dial-failed"));
    expect(nowhere.log().some((line) => line.event === "rejected")).toBe(false);
  });

  test("a missing required key stops the agent and names the key", async () => {
    const home = tempDir();
    ensureAgentBuilt();
    const child = Bun.spawn([...AGENT_COMMAND], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, JAKE_HUB_URL: "ws://127.0.0.1:9", JAKE_AGENT_NAME: "box" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("JAKE_SECRET");
  });
});

describe("running commands", () => {
  let connection: HubConnection;
  let work: string;

  beforeAll(async () => {
    const hub = standInHub();
    agent(hub.url);
    connection = await hub.welcomed(0);
    work = tempDir();
  });

  test("streams output as it is produced, before the command ends", async () => {
    const go = join(work, "go");
    const id = "streaming";
    connection.send({
      type: "exec",
      id,
      shell: "linux",
      command: `printf first; while [ ! -e '${go}' ]; do sleep 0.01; done; printf second`,
      cwd: null,
      env: {},
      distro: null,
    });
    const first = await connection.next((f) => f.id === id && f.type === "stdout", "the first chunk");
    expect(bytesOf(first).toString()).toBe("first");
    expect(connection.all((f) => f.id === id && f.type === "exit")).toEqual([]);
    writeFileSync(go, "");
    const exit = await connection.next((f) => f.id === id && f.type === "exit", "the exit");
    expect(exit).toMatchObject({ code: 0, signal: null, canceled: false });
    const chunks = connection.all((f) => f.id === id && f.type === "stdout");
    expect(Buffer.concat(chunks.map(bytesOf)).toString()).toBe("firstsecond");
    expect(chunks.map((f) => f.seq)).toEqual(chunks.map((_, index) => index));
  });

  test("keeps stdout and stderr apart in one sequence and reports a non-zero exit", async () => {
    const result = await run(connection, "echo out; echo err >&2; exit 3");
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.end).toMatchObject({ type: "exit", code: 3, canceled: false });
    expect(result.output.map((f) => f.seq).sort()).toEqual(result.output.map((_, index) => index));
  });

  test("runs in the requested directory with the environment overlay over the agent's own", async () => {
    const result = await run(connection, 'printf "%s|%s|%s" "$GREETING" "$PWD" "${PATH:+kept}"', { cwd: work, env: { GREETING: "안녕" } });
    expect(result.stdout).toBe(`안녕|${work}|kept`);
  });

  test("a command that cannot start is reported as an error, not an exit", async () => {
    const result = await run(connection, "true", { cwd: join(work, "no-such-dir") });
    expect(result.end).toMatchObject({ type: "error", code: "spawn-failed" });
  });

  test("a cancel ends the command's whole process tree and is reported as a cancel", async () => {
    const id = "canceled";
    connection.send({ type: "exec", id, shell: "linux", command: "sleep 300 & echo $!; wait", cwd: null, env: {}, distro: null });
    const pid = Number.parseInt(bytesOf(await connection.next((f) => f.id === id && f.type === "stdout", "the child pid")).toString(), 10);
    expect(alive(pid)).toBe(true);
    connection.send({ type: "cancel", id });
    const exit = await connection.next((f) => f.id === id && f.type === "exit", "the canceled exit");
    expect(exit.canceled).toBe(true);
    await until("the grandchild to be gone", () => !alive(pid));
  });

  test("a cancel for a command that already ended changes nothing", async () => {
    const result = await run(connection, "true");
    connection.send({ type: "cancel", id: (result.end as WireFrame).id });
    const after = await run(connection, "echo still");
    expect(after.stdout).toBe("still\n");
  });
});

describe("the caps on a command", () => {
  let connection: HubConnection;

  beforeAll(async () => {
    const hub = standInHub();
    agent(hub.url, { JAKE_EXEC_MAX_OUTPUT_BYTES: "1000", JAKE_EXEC_TIMEOUT_MS: "300" });
    connection = await hub.welcomed(0);
  });

  test("output past the cap stops the command and says so as its last line", async () => {
    const result = await run(connection, "yes");
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
    expect(result.stderr).toContain("[jake] output cap of 1000 bytes reached; command terminated");
    expect(result.end).toMatchObject({ type: "exit", canceled: false });
  });

  test("a command past the time limit is stopped and says so as its last line", async () => {
    const result = await run(connection, "sleep 300");
    expect(result.stderr).toContain("[jake] time limit of 300 ms reached; command terminated");
    expect(result.end).toMatchObject({ type: "exit", canceled: false });
  });
});

describe("a dropped socket", () => {
  test("ends every command that was running over it", async () => {
    const hub = standInHub();
    agent(hub.url);
    const connection = await hub.welcomed(0);
    const id = "orphan";
    connection.send({ type: "exec", id, shell: "linux", command: "sleep 300 & echo $!; wait", cwd: null, env: {}, distro: null });
    const pid = Number.parseInt(bytesOf(await connection.next((f) => f.id === id && f.type === "stdout", "the child pid")).toString(), 10);
    connection.close();
    await until("the command's tree to be gone", () => !alive(pid));
    const next = await hub.welcomed(1);
    expect(next.all((f) => f.id === id)).toEqual([]);
  });
});

describe("file transfer", () => {
  let connection: HubConnection;
  let work: string;

  beforeAll(async () => {
    const hub = standInHub();
    agent(hub.url);
    connection = await hub.welcomed(0);
    work = tempDir();
  });

  function upload(id: string, path: string, content: Buffer, chunks: Buffer[], declared = { total: content.length, checksum: sha256(content) }): void {
    connection.send({ type: "transfer-begin", id, direction: "upload", path, total: declared.total, checksum: declared.checksum });
    chunks.forEach((chunk, seq) => {
      connection.send({ type: "transfer-chunk", id, seq, chunk: { bytes: chunk.length, base64: chunk.toString("base64") } });
    });
  }

  function split(content: Buffer): Buffer[] {
    const pieces: Buffer[] = [];
    for (let at = 0; at < content.length; at += CHUNK) pieces.push(content.subarray(at, at + CHUNK));
    return pieces;
  }

  const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".part"));

  test("an upload lands whole, moved into place once it verifies, and is acknowledged", async () => {
    const content = randomBytes(CHUNK * 2 + 1234);
    const path = join(work, "landed.bin");
    upload("u1", path, content, split(content));
    connection.send({ type: "transfer-end", id: "u1", total: content.length, checksum: sha256(content) });
    const end = await connection.next((f) => f.id === "u1", "the upload's answer");
    expect(end).toMatchObject({ type: "transfer-end", total: content.length, checksum: sha256(content) });
    expect(sha256(readFileSync(path))).toBe(sha256(content));
    expect(leftovers(work)).toEqual([]);
  });

  test("content that does not match its checksum is refused and nothing is left behind", async () => {
    const content = randomBytes(5000);
    const path = join(work, "torn.bin");
    upload("u2", path, content, split(content), { total: content.length, checksum: sha256("other") });
    connection.send({ type: "transfer-end", id: "u2", total: content.length, checksum: sha256("other") });
    const answer = await connection.next((f) => f.id === "u2", "the integrity error");
    expect(answer).toMatchObject({ type: "error", code: "integrity" });
    expect(existsSync(path)).toBe(false);
    await until("the temp file to go", () => leftovers(work).length === 0);
  });

  test("a chunk out of order fails the upload rather than assembling a gap", async () => {
    const content = randomBytes(CHUNK + 10);
    const tail = split(content)[1] as Buffer;
    connection.send({ type: "transfer-begin", id: "u3", direction: "upload", path: join(work, "gap.bin"), total: content.length, checksum: sha256(content) });
    connection.send({ type: "transfer-chunk", id: "u3", seq: 1, chunk: { bytes: tail.length, base64: tail.toString("base64") } });
    const answer = await connection.next((f) => f.id === "u3", "the out-of-order error");
    expect(answer).toMatchObject({ type: "error", code: "out-of-order" });
    await until("the temp file to go", () => leftovers(work).length === 0);
  });

  test("an upload the hub gives up on is discarded with its temp file, and answers nothing", async () => {
    const content = randomBytes(CHUNK + 10);
    const path = join(work, "abandoned.bin");
    upload("u4", path, content, split(content).slice(0, 1));
    await until("the temp file to appear", () => leftovers(work).length === 1);
    connection.send({ type: "error", id: "u4", code: "aborted", message: "the caller went away" });
    await until("the temp file to go", () => leftovers(work).length === 0);
    const after = await run(connection, "true");
    expect(after.end.type).toBe("exit");
    expect(connection.all((f) => f.id === "u4")).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("a download answers with the size and checksum, then the file in ordered chunks", async () => {
    const content = randomBytes(CHUNK * 2 + 77);
    const path = join(work, "served.bin");
    writeFileSync(path, content);
    connection.send({ type: "transfer-begin", id: "d1", direction: "download", path, total: null, checksum: null });
    const begin = await connection.next((f) => f.id === "d1" && f.type === "transfer-begin", "the download's begin");
    expect(begin).toMatchObject({ direction: "download", path, total: content.length, checksum: sha256(content) });
    const end = await connection.next((f) => f.id === "d1" && f.type === "transfer-end", "the download's end");
    expect(end).toMatchObject({ total: content.length, checksum: sha256(content) });
    const chunks = connection.all((f) => f.id === "d1" && f.type === "transfer-chunk");
    expect(chunks.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(chunks.every((f) => bytesOf(f).length <= CHUNK)).toBe(true);
    expect(sha256(Buffer.concat(chunks.map(bytesOf)))).toBe(sha256(content));
  });

  test("a download of a missing file, a directory, or an unreadable file names what went wrong", async () => {
    const locked = join(work, "locked.bin");
    writeFileSync(locked, "secret");
    chmodSync(locked, 0o000);
    const cases: Array<[string, string]> = [
      [join(work, "absent.bin"), "not-found"],
      [work, "is-directory"],
      [locked, "permission"],
    ];
    for (const [index, [path, code]] of cases.entries()) {
      const id = `d-fail-${index}`;
      connection.send({ type: "transfer-begin", id, direction: "download", path, total: null, checksum: null });
      expect(await connection.next((f) => f.id === id, `the ${code} error`)).toMatchObject({ type: "error", code });
    }
  });
});

describe("leaving", () => {
  test("a leave stops the agent, hands its removal to a detached systemd unit, and exits", async () => {
    const home = tempDir();
    const bin = join(home, "bin");
    mkdirSync(bin);
    const record = join(home, "systemd-run.args");
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 });

    const hub = standInHub();
    const leaving = agent(hub.url, { PATH: `${bin}:${process.env.PATH ?? ""}` }, home);
    const connection = await hub.welcomed(0);
    connection.send({ type: "leave" });
    expect(await leaving.exited).toBe(0);
    await until("the teardown to be handed off", () => existsSync(record));

    const args = readFileSync(record, "utf8");
    const dataDir = join(home, ".local", "share", "jake");
    expect(args.startsWith("--user\n--collect\n--unit\njake-depart\n/bin/sh\n-c\n")).toBe(true);
    expect(args).toContain("systemctl --user disable --now jake-agent.service");
    expect(args).toContain(`rm -rf '${dataDir}'`);
  });

  test("the uninstaller's leave notice says hello, sends a leave once welcomed, and exits; a refusal fails it", async () => {
    const hub = standInHub();
    const notice = (secret: string) => {
      const home = tempDir();
      return Bun.spawn([...AGENT_COMMAND, "--leave"], {
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HOME: home, JAKE_HUB_URL: hub.url, JAKE_SECRET: secret, JAKE_AGENT_NAME: "box" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
    };
    ensureAgentBuilt();

    const told = notice(SECRET);
    const connection = await hub.welcomed(0);
    await connection.next((f) => f.type === "leave", "the leave notice");
    expect(await told.exited).toBe(0);

    const refused = notice("wrong-secret");
    expect(await refused.exited).not.toBe(0);
    expect(await new Response(refused.stderr).text()).toContain("refused");
  });
});
