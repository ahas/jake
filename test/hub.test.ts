import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  TRANSFER_CHUNK_BYTES,
  checksum,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  streamChecksum,
  type Frame,
} from "../src/protocol";
import { ensureHubBuilt, startHubClient, startHubProcess, type HubProcess, type HubSeams } from "./hub-process";
import { StandInPort } from "./stand-in-port";
import { HubClient, type UploadContent } from "../src/console/client";
import { ensureAgentBuilt, startAgentProcess, type AgentProcess } from "./agent-process";

const V = PROTOCOL_VERSION;
const SECRET = "s3cr3t";
const CONTROL = "c0nsole";
const OPTS = { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES };

// Everything a test starts, torn down after it so no server or socket outlives the case.
const running: HubProcess[] = [];
const agents: FakeAgent[] = [];
const readers: SseReader[] = [];
const realAgents: AgentProcess[] = [];
const dirs: string[] = [];
const callers: StreamCaller[] = [];
const clients: Bun.Subprocess[] = [];
const ports: StandInPort[] = [];

// A build after a change takes far longer than one case may, so both programs are built before any.
beforeAll(() => {
  ensureHubBuilt();
  ensureAgentBuilt();
}, 600_000);

afterEach(async () => {
  for (const reader of readers.splice(0)) reader.close();
  for (const caller of callers.splice(0)) caller.ws.close();
  for (const client of clients.splice(0)) client.kill("SIGKILL");
  for (const port of ports.splice(0)) port.stop();
  for (const agent of agents.splice(0)) agent.close();
  await Promise.all(realAgents.splice(0).map((agent) => agent.stop()));
  await Promise.all(running.splice(0).map((hub) => hub.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(seams: HubSeams = {}): Promise<HubProcess> {
  const hub = await startHubProcess(SECRET, CONTROL, seams);
  running.push(hub);
  return hub;
}

// --- A fake agent: a real WebSocket client dialing the hub's agent port -------------------------

class FakeAgent {
  readonly ws: WebSocket;
  readonly received: Frame[] = [];
  closeCode: number | null = null;
  closeReason: string | null = null;
  private readonly matched = new Set<Frame>();
  private readonly waiters = new Set<(frame: Frame) => boolean>();
  private opened: "open" | "error" | null = null;
  private readonly openWaiters: ((outcome: "open" | "error") => void)[] = [];
  private readonly closeWaiters: (() => void)[] = [];

  constructor(port: number, secret: string, autoPong = true) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${secret}` } } as never);
    this.ws.addEventListener("open", () => {
      this.opened = "open";
      for (const w of this.openWaiters.splice(0)) w("open");
    });
    this.ws.addEventListener("error", () => {
      if (this.opened === null) {
        this.opened = "error";
        for (const w of this.openWaiters.splice(0)) w("error");
      }
    });
    this.ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      this.closeReason = event.reason;
      for (const w of this.closeWaiters.splice(0)) w();
    });
    this.ws.addEventListener("message", (event) => {
      const result = decodeFrame(String(event.data), OPTS);
      if (!result.ok) return;
      const frame = result.frame;
      if (frame.type === "ping" && autoPong) {
        this.send({ type: "pong", v: V, ts: frame.ts });
      }
      this.received.push(frame);
      for (const waiter of [...this.waiters]) waiter(frame);
    });
  }

  send(frame: Frame): void {
    this.ws.send(encodeFrame(frame));
  }

  hello(capabilities: string[] = [], name = "hass-desktop", version = "0.1.0"): void {
    this.send({ type: "hello", v: V, agent: name, agentVersion: version, capabilities });
  }

  outcome(): Promise<"open" | "error"> {
    if (this.opened !== null) return Promise.resolve(this.opened);
    return new Promise((resolve) => this.openWaiters.push(resolve));
  }

  waitClose(timeoutMs = 2000): Promise<void> {
    if (this.closeCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitClose timed out")), timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  waitFor(pred: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    for (const frame of this.received) {
      if (!this.matched.has(frame) && pred(frame)) {
        this.matched.add(frame);
        return Promise.resolve(frame);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("waitFor (agent) timed out"));
      }, timeoutMs);
      const waiter = (frame: Frame): boolean => {
        if (this.matched.has(frame) || !pred(frame)) return false;
        this.matched.add(frame);
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(frame);
        return true;
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
  }
}

async function attach(port: number, capabilities: string[] = [], name?: string): Promise<FakeAgent> {
  const agent = new FakeAgent(port, SECRET);
  agents.push(agent);
  expect(await agent.outcome()).toBe("open");
  agent.hello(capabilities, name);
  await agent.waitFor((f) => f.type === "welcome");
  return agent;
}

// --- An SSE reader over the control API ---------------------------------------------------------

interface SseEvent {
  event: string;
  data: unknown;
  id?: number;
}

class SseReader {
  readonly events: SseEvent[] = [];
  private readonly matched = new Set<SseEvent>();
  private readonly waiters = new Set<(event: SseEvent) => boolean>();
  private readonly controller = new AbortController();
  readonly ready: Promise<Response>;

  constructor(url: string, init: RequestInit) {
    this.ready = fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${CONTROL}`, ...(init.headers ?? {}) },
      signal: this.controller.signal,
    }).then((response) => {
      if (response.body !== null && response.headers.get("content-type")?.startsWith("text/event-stream")) {
        void this.pump(response.body.getReader());
      }
      return response;
    });
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          this.consume(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
    } catch {
      // aborted or the connection dropped
    }
  }

  private consume(block: string): void {
    if (block.startsWith(":")) return; // keep-alive comment
    let event = "message";
    let data = "";
    let id: number | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
      else if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
    }
    const parsed: SseEvent = { event, data: data === "" ? undefined : JSON.parse(data), id };
    this.events.push(parsed);
    for (const waiter of [...this.waiters]) waiter(parsed);
  }

  waitFor(pred: (event: SseEvent) => boolean, timeoutMs = 2000): Promise<SseEvent> {
    for (const event of this.events) {
      if (!this.matched.has(event) && pred(event)) {
        this.matched.add(event);
        return Promise.resolve(event);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("waitFor (sse) timed out"));
      }, timeoutMs);
      const waiter = (event: SseEvent): boolean => {
        if (this.matched.has(event) || !pred(event)) return false;
        this.matched.add(event);
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(event);
        return true;
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    this.controller.abort();
  }
}

function openSse(url: string, init: RequestInit): SseReader {
  const reader = new SseReader(url, init);
  readers.push(reader);
  return reader;
}

/** The agent itself, as its own process, under a home of its own. */
function startRealAgent(hubUrl: string, secret: string, env: Record<string, string> = {}): AgentProcess {
  const home = mkdtempSync(join(tmpdir(), "jake-hub-agent-"));
  dirs.push(home);
  const agent = startAgentProcess({ hubUrl, secret, name: "hass", home, env: { JAKE_REDIAL_BASE_MS: "20", ...env } });
  realAgents.push(agent);
  return agent;
}

async function control(hub: HubProcess, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.controlPort}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CONTROL}`, ...(init.headers ?? {}) },
  });
}

/** Wait, bounded, for a condition another process settles. */
async function until(pred: () => boolean | Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}

// --- A stream's caller: a WebSocket on the control API's /connect -------------------------------

class StreamCaller {
  readonly ws: WebSocket;
  readonly received: Buffer[] = [];
  closeCode: number | null = null;
  closeReason = "";

  constructor(hub: HubProcess, query: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${hub.controlPort}/connect?${query}`, {
      headers: { Authorization: `Bearer ${CONTROL}` },
    } as never);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (event) => {
      this.received.push(Buffer.from(event.data as ArrayBuffer));
    });
    this.ws.addEventListener("close", (event) => {
      this.closeCode = event.code;
      this.closeReason = event.reason;
    });
  }

  get bytes(): Buffer {
    return Buffer.concat(this.received);
  }

  async closed(): Promise<{ code: number | null; reason: string }> {
    await until(() => this.closeCode !== null);
    return { code: this.closeCode, reason: this.closeReason };
  }
}

function openCaller(hub: HubProcess, query: string): StreamCaller {
  const caller = new StreamCaller(hub, query);
  callers.push(caller);
  return caller;
}

const utf8 = new TextEncoder();
function decodeChunk(chunk: { base64: string }): string {
  return new TextDecoder().decode(Uint8Array.from(Buffer.from(chunk.base64, "base64")));
}

// --- Tests --------------------------------------------------------------------------------------

describe("agent authentication", () => {
  test("accepts an agent presenting the shared secret and records its hello", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec", "fetch"], "hass-desktop");

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(true);
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]).toMatchObject({ name: "hass-desktop", capabilities: ["exec", "fetch"], inFlight: [] });
    expect(agent.received.some((f) => f.type === "welcome")).toBe(true);
  });

  test("rejects an agent presenting the wrong secret at the upgrade, logging it without the value", async () => {
    const hub = await launch();
    const agent = new FakeAgent(hub.agentPort, "wrong-secret");
    agents.push(agent);
    expect(await agent.outcome()).toBe("error");

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(false);

    const plain = await fetch(`http://127.0.0.1:${hub.agentPort}/`, { headers: { Authorization: "Bearer nope" } });
    expect(plain.status).toBe(401);
    await until(() => hub.stderr.length > 0);
    expect(hub.stderr).toEqual(["jake hub: refused an agent connection from 127.0.0.1 (a wrong credential)"]);
  });

  test("the agent tells this hub's refusal of its secret apart from a hub that does not answer", async () => {
    const hub = await launch();
    const refused = startRealAgent(`ws://127.0.0.1:${hub.agentPort}`, "wrong-secret");
    await until(() => refused.log().some((line) => line.event === "rejected" && line.status === 401));

    const vacant = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadPort = vacant.port;
    vacant.stop(true);
    const unreachable = startRealAgent(`ws://127.0.0.1:${deadPort}`, SECRET);
    await until(() => unreachable.log().some((line) => line.event === "dial-failed"));
    expect(unreachable.log().some((line) => line.event === "rejected")).toBe(false);
  });

  test("rejects a control request without the control token", async () => {
    const hub = await launch();
    const response = await fetch(`http://127.0.0.1:${hub.controlPort}/status`);
    expect(response.status).toBe(401);
  });
});

function execBody(command: string): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shell: "linux", command }) };
}

describe("many agents", () => {
  test("agents under different names attach side by side and neither displaces the other", async () => {
    const hub = await launch();
    const wsl = await attach(hub.agentPort, ["exec:wsl"], "jake_wsl");
    const node2 = await attach(hub.agentPort, ["exec:linux"], "node2");

    const status = await (await control(hub, "/status")).json();
    expect(status.agents.map((a: { name: string }) => a.name)).toEqual(["jake_wsl", "node2"]);
    expect(status.agents[1]).toMatchObject({ capabilities: ["exec:linux"], inFlight: [] });
    expect(wsl.closeCode).toBeNull();
    expect(node2.closeCode).toBeNull();
  });

  test("a reconnect under a name already held replaces that connection alone", async () => {
    const hub = await launch();
    const first = await attach(hub.agentPort, [], "hass-desktop");
    const other = await attach(hub.agentPort, [], "node2");
    const second = await attach(hub.agentPort, [], "hass-desktop");

    await first.waitClose();
    expect(first.closeCode).toBe(4000);
    expect(first.closeReason).toBe("superseded by a new connection");
    expect(other.closeCode).toBeNull();

    const status = await (await control(hub, "/status")).json();
    expect(status.agents.map((a: { name: string }) => a.name)).toEqual(["hass-desktop", "node2"]);

    // The surviving connection is the second: a named command reaches it.
    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec?agent=hass-desktop`, execBody("hostname"));
    await reader.ready;
    await second.waitFor((f) => f.type === "exec");
  });

  test("a named command goes to that agent only, and its output comes back from it", async () => {
    const hub = await launch();
    const wsl = await attach(hub.agentPort, [], "jake_wsl");
    const node2 = await attach(hub.agentPort, [], "node2");

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec?agent=node2`, execBody("hostname"));
    await reader.ready;
    const exec = await node2.waitFor((f) => f.type === "exec");
    const id = (exec as { id: string }).id;
    node2.send({ type: "stdout", v: V, id, seq: 0, chunk: { bytes: 6, base64: Buffer.from("node2\n").toString("base64") } });
    node2.send({ type: "exit", v: V, id, code: 0, signal: null, canceled: false });

    const out = await reader.waitFor((e) => e.event === "stdout");
    expect(decodeChunk((out.data as { chunk: { base64: string } }).chunk)).toBe("node2\n");
    await reader.waitFor((e) => e.event === "exit");
    expect(wsl.received.some((f) => f.type === "exec")).toBe(false);
  });

  test("with several attached, a request naming none or an absent one is refused", async () => {
    const hub = await launch();
    await attach(hub.agentPort, [], "jake_wsl");
    await attach(hub.agentPort, [], "node2");

    const unnamed = await control(hub, "/exec", execBody("hostname"));
    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toMatchObject({ code: "agent-required", error: expect.stringContaining("jake_wsl, node2") });

    const absent = await control(hub, "/download?path=/x&agent=ghost", { method: "POST" });
    expect(absent.status).toBe(404);
    expect((await absent.json()).code).toBe("unknown-agent");

    const leave = await control(hub, "/leave", { method: "POST" });
    expect(leave.status).toBe(400);
  });

  test("an agent that drops ends only its own commands", async () => {
    const hub = await launch();
    const wsl = await attach(hub.agentPort, [], "jake_wsl");
    const node2 = await attach(hub.agentPort, [], "node2");

    const onWsl = openSse(`http://127.0.0.1:${hub.controlPort}/exec?agent=jake_wsl`, execBody("sleep 60"));
    const onNode2 = openSse(`http://127.0.0.1:${hub.controlPort}/exec?agent=node2`, execBody("sleep 60"));
    await Promise.all([onWsl.ready, onNode2.ready]);
    await wsl.waitFor((f) => f.type === "exec");
    const exec = await node2.waitFor((f) => f.type === "exec");

    wsl.close();
    const ended = await onWsl.waitFor((e) => e.event === "ended");
    expect(ended.data).toMatchObject({ reason: "agent connection closed" });

    const status = await (await control(hub, "/status")).json();
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]).toMatchObject({ name: "node2", inFlight: [(exec as { id: string }).id] });

    // The other agent's command still streams, and cancel finds it by its id alone.
    const cancel = await control(hub, "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: (exec as { id: string }).id }),
    });
    expect(cancel.status).toBe(200);
    await node2.waitFor((f) => f.type === "cancel");
    expect(onNode2.events.some((e) => e.event === "ended")).toBe(false);
  });

  test("a leave reaches the named agent and leaves the others installed", async () => {
    const hub = await launch();
    const wsl = await attach(hub.agentPort, [], "jake_wsl");
    const node2 = await attach(hub.agentPort, [], "node2");

    const response = await control(hub, "/leave?agent=node2", { method: "POST" });
    expect(await response.json()).toEqual({ ok: true, agent: "node2" });
    await node2.waitFor((f) => f.type === "leave");
    expect(wsl.received.some((f) => f.type === "leave")).toBe(false);
  });

  test("the traffic log tags each frame with its agent", async () => {
    const hub = await launch();
    await attach(hub.agentPort, [], "jake_wsl");
    await attach(hub.agentPort, [], "node2");

    // The replay a console opening now catches up on carries every handshake frame, tagged.
    const tail = openSse(`http://127.0.0.1:${hub.controlPort}/events`, { method: "GET" });
    const handshake = (e: SseEvent): boolean => e.event === "traffic" && ["hello", "welcome"].includes((e.data as { type: string }).type);
    const hellos: { agent: string; type: string }[] = [];
    for (let i = 0; i < 4; i += 1) hellos.push((await tail.waitFor(handshake)).data as { agent: string; type: string });
    expect(hellos.map((entry) => `${entry.agent} ${entry.type}`)).toEqual([
      "jake_wsl hello",
      "jake_wsl welcome",
      "node2 hello",
      "node2 welcome",
    ]);
  });
});

describe("exec streaming", () => {
  test("streams a command's output through to an SSE reader in order", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "powershell", command: "echo hi" }),
    });
    await reader.ready;

    const started = await reader.waitFor((e) => e.event === "started");
    const id = (started.data as { id: string }).id;

    const exec = await agent.waitFor((f) => f.type === "exec");
    expect(exec).toMatchObject({ id, shell: "powershell", command: "echo hi" });

    const chunk = (text: string) => ({ bytes: utf8.encode(text).byteLength, base64: Buffer.from(text).toString("base64") });
    agent.send({ type: "stdout", v: V, id, seq: 0, chunk: chunk("one\n") });
    agent.send({ type: "stdout", v: V, id, seq: 1, chunk: chunk("two\n") });
    agent.send({ type: "stderr", v: V, id, seq: 0, chunk: chunk("warn\n") });
    agent.send({ type: "exit", v: V, id, code: 0, signal: null, canceled: false });

    const out0 = await reader.waitFor((e) => e.event === "stdout" && (e.data as { seq: number }).seq === 0);
    const out1 = await reader.waitFor((e) => e.event === "stdout" && (e.data as { seq: number }).seq === 1);
    const err0 = await reader.waitFor((e) => e.event === "stderr");
    const exit = await reader.waitFor((e) => e.event === "exit");

    expect(decodeChunk((out0.data as { chunk: { base64: string } }).chunk)).toBe("one\n");
    expect(decodeChunk((out1.data as { chunk: { base64: string } }).chunk)).toBe("two\n");
    expect(decodeChunk((err0.data as { chunk: { base64: string } }).chunk)).toBe("warn\n");
    expect(exit.data).toMatchObject({ code: 0, canceled: false });

    // The events arrived in the order the agent emitted them.
    const kinds = reader.events.map((e) => e.event);
    expect(kinds.indexOf("stdout")).toBeLessThan(kinds.indexOf("exit"));
    expect(kinds.filter((k) => k === "stdout").length).toBe(2);
  });

  test("cancel reaches the agent and the run ends as canceled", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "wsl", command: "sleep 100", distro: "Ubuntu" }),
    });
    await reader.ready;
    const started = await reader.waitFor((e) => e.event === "started");
    const id = (started.data as { id: string }).id;
    await agent.waitFor((f) => f.type === "exec");

    const cancelResponse = await control(hub, "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(cancelResponse.status).toBe(200);

    await agent.waitFor((f) => f.type === "cancel" && f.id === id);
    agent.send({ type: "exit", v: V, id, code: null, signal: "SIGTERM", canceled: true });

    const exit = await reader.waitFor((e) => e.event === "exit");
    expect(exit.data).toMatchObject({ canceled: true, signal: "SIGTERM" });
  });

  test("an agent disconnect ends every in-flight command explicitly", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "powershell", command: "Start-Sleep 100" }),
    });
    await reader.ready;
    await reader.waitFor((e) => e.event === "started");
    await agent.waitFor((f) => f.type === "exec");

    agent.close();

    const ended = await reader.waitFor((e) => e.event === "ended");
    expect((ended.data as { reason: string }).reason).toContain("closed");
  });

  test("exec against a hub with no agent is refused", async () => {
    const hub = await launch();
    const response = await control(hub, "/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "powershell", command: "echo hi" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("file transfer over the control API", () => {
  function hubClient(hub: HubProcess): HubClient {
    return new HubClient({ baseUrl: `http://127.0.0.1:${hub.controlPort}`, token: CONTROL });
  }

  function contentOf(bytes: Uint8Array<ArrayBuffer>): UploadContent {
    return { file: new Blob([bytes]), checksum: checksum(bytes) };
  }

  // A real agent process over a real socket, writing what it receives to disk and verifying it.
  async function attachRealAgent(hub: HubProcess): Promise<void> {
    startRealAgent(`ws://127.0.0.1:${hub.agentPort}`, SECRET);
    let names: string[] = [];
    await until(async () => {
      names = (await (await control(hub, "/status")).json()).agents.map((a: { name: string }) => a.name);
      return names.length > 0;
    });
    expect(names).toEqual(["hass"]);
  }

  test("upload: a file past the HTTP body limit streams from disk to disk and lands byte for byte", async () => {
    // 300 MiB is well past the 128 MiB a Bun server takes as one request body by default.
    const hub = await launch();
    await attachRealAgent(hub);
    const dir = mkdtempSync(join(tmpdir(), "jake-hub-upload-"));
    dirs.push(dir);
    const source = join(dir, "source.bin");
    const landed = join(dir, "landed.bin");

    // Each mebibyte carries its own index, so a chunk out of place changes the checksum.
    const block = new Uint8Array(randomBytes(1024 * 1024));
    const writer = Bun.file(source).writer();
    for (let i = 0; i < 300; i += 1) {
      new DataView(block.buffer).setUint32(0, i);
      writer.write(block);
      await writer.flush();
    }
    await writer.end();

    const file = Bun.file(source);
    const sum = await streamChecksum(file.stream());
    const outcome = await hubClient(hub).upload(landed, { file, checksum: sum });

    expect(outcome).toMatchObject({ kind: "completed", total: 300 * 1024 * 1024, checksum: sum });
    expect(await streamChecksum(Bun.file(landed).stream())).toBe(sum);
  }, 120_000);

  test("upload: a caller that declares no length or checksum has them learned from its body", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const content = new Uint8Array(1000).map((_, i) => i % 7);

    const upload = control(hub, "/upload?path=/remote/plain.bin", { method: "POST", body: new Blob([content]) });
    const begin = await agent.waitFor((f) => f.type === "transfer-begin");
    await agent.waitFor((f) => f.type === "transfer-end");
    if (begin.type !== "transfer-begin") throw new Error("unexpected frame");
    expect(begin).toMatchObject({ total: content.byteLength, checksum: checksum(content) });

    agent.send({ type: "transfer-end", v: V, id: begin.id, total: content.byteLength, checksum: checksum(content) });
    expect(await (await upload).text()).toContain("event: completed");
  });

  test("upload: a declared length without a well-formed checksum is a bad request", async () => {
    const hub = await launch();
    await attach(hub.agentPort, ["transfer"]);
    const body = new Blob([new Uint8Array([1])]);
    expect((await control(hub, "/upload?path=/x&total=1", { method: "POST", body })).status).toBe(400);
    expect((await control(hub, "/upload?path=/x&total=1&checksum=XYZ", { method: "POST", body })).status).toBe(400);
    expect((await control(hub, `/upload?path=/x&total=-1&checksum=${checksum(new Uint8Array([1]))}`, { method: "POST", body })).status).toBe(400);
  });

  test("upload: the hub chunks the file to the agent, which acknowledges the verified write", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const client = hubClient(hub);

    // Past the fixed chunk size, so more than one chunk frame must cross.
    const content = new Uint8Array(300 * 1024).map((_, i) => i % 251);
    const uploadP = client.upload("/remote/out.bin", contentOf(content));

    const begin = await agent.waitFor((f) => f.type === "transfer-begin");
    const end = await agent.waitFor((f) => f.type === "transfer-end");
    if (begin.type !== "transfer-begin" || end.type !== "transfer-end") throw new Error("unexpected frames");
    expect(begin.direction).toBe("upload");
    expect(begin.total).toBe(content.byteLength);
    expect(begin.checksum).toBe(checksum(content));
    expect(agent.received.filter((f) => f.type === "transfer-chunk").length).toBeGreaterThan(1);

    // The agent verified and moved the file into place; it acknowledges by echoing an end frame.
    agent.send({ type: "transfer-end", v: V, id: begin.id, total: begin.total ?? 0, checksum: begin.checksum ?? "" });

    expect(await uploadP).toMatchObject({ kind: "completed", total: content.byteLength });
  });

  test("upload: a file many times the socket's backlog limit reaches the agent whole and in order", async () => {
    // The hub's socket discards frames past its backlog limit; a small limit reaches that with a small
    // file, the way Bun's default limit is reached by a file of twenty-odd megabytes.
    // The agent reads on the hub's own event loop, so it falls behind the hub's writes the way a slow
    // link does and the socket's backlog passes its limit many times over.
    const hub = await launch({ socketBacklogBytes: 512 * 1024 });
    const agent = await attach(hub.agentPort, ["transfer"]);
    const client = hubClient(hub);

    const content = new Uint8Array(12 * 1024 * 1024).map((_, i) => (i * 31) % 253);
    const uploadP = client.upload("/remote/big.bin", contentOf(content));

    const begin = await agent.waitFor((f) => f.type === "transfer-begin");
    const end = await agent.waitFor((f) => f.type === "transfer-end");
    if (begin.type !== "transfer-begin" || end.type !== "transfer-end") throw new Error("unexpected frames");

    const chunks = agent.received.filter((f): f is Extract<Frame, { type: "transfer-chunk" }> => f.type === "transfer-chunk");
    expect(chunks.map((f) => f.seq)).toEqual(chunks.map((_, i) => i));
    const assembled = Buffer.concat(chunks.map((f) => Buffer.from(f.chunk.base64, "base64")));
    expect(checksum(assembled)).toBe(checksum(content));
    expect(end).toMatchObject({ total: content.byteLength, checksum: checksum(content) });

    agent.send({ type: "transfer-end", v: V, id: begin.id, total: end.total, checksum: end.checksum });
    expect(await uploadP).toMatchObject({ kind: "completed", total: content.byteLength });
  });

  test("download: the agent streams the file and the hub verifies it before completing", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const client = hubClient(hub);

    const content = new Uint8Array(300 * 1024).map((_, i) => (i * 7) % 251);
    const sum = checksum(content);
    const received: Uint8Array[] = [];
    const downloadP = client.download("/remote/in.bin", { onChunk: (bytes) => received.push(bytes) });

    const req = await agent.waitFor((f) => f.type === "transfer-begin");
    if (req.type !== "transfer-begin") throw new Error("unexpected frame");
    expect(req.direction).toBe("download");

    agent.send({ type: "transfer-begin", v: V, id: req.id, direction: "download", path: req.path, total: content.byteLength, checksum: sum });
    const half = content.byteLength >> 1;
    agent.send({ type: "transfer-chunk", v: V, id: req.id, seq: 0, chunk: encodeBytes(content.subarray(0, half)) });
    agent.send({ type: "transfer-chunk", v: V, id: req.id, seq: 1, chunk: encodeBytes(content.subarray(half)) });
    agent.send({ type: "transfer-end", v: V, id: req.id, total: content.byteLength, checksum: sum });

    expect(await downloadP).toMatchObject({ kind: "completed", total: content.byteLength, checksum: sum });

    const assembled = new Uint8Array(received.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of received) {
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(assembled).toEqual(content);
  });

  test("upload: a body arriving in pieces of any size reaches the agent as fixed chunks, whole and in order", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const content = new Uint8Array(TRANSFER_CHUNK_BYTES * 2 + 1234).map((_, i) => (i * 13) % 241);
    const pieces = [content.subarray(0, 7), content.subarray(7, TRANSFER_CHUNK_BYTES + 99), content.subarray(TRANSFER_CHUNK_BYTES + 99)];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });

    const upload = control(hub, `/upload?path=/remote/pieces.bin&total=${content.byteLength}&checksum=${checksum(content)}`, { method: "POST", body });
    const end = await agent.waitFor((f) => f.type === "transfer-end");
    const chunks = agent.received.filter((f): f is Extract<Frame, { type: "transfer-chunk" }> => f.type === "transfer-chunk");
    expect(chunks.map((f) => f.chunk.bytes)).toEqual([TRANSFER_CHUNK_BYTES, TRANSFER_CHUNK_BYTES, 1234]);
    expect(checksum(Buffer.concat(chunks.map((f) => Buffer.from(f.chunk.base64, "base64"))))).toBe(checksum(content));

    if (end.type !== "transfer-end") throw new Error("unexpected frame");
    agent.send({ type: "transfer-end", v: V, id: end.id, total: end.total, checksum: end.checksum });
    expect(await (await upload).text()).toContain("event: completed");
  });

  test("upload: a body shorter or longer than its declared total fails the upload, tells the agent, and sends no end", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const content = new Uint8Array(10_000).map((_, i) => i % 199);
    for (const declared of [10_001, 9_999]) {
      const response = await control(hub, `/upload?path=/remote/size.bin&total=${declared}&checksum=${checksum(content)}`, {
        method: "POST",
        body: new Blob([content]),
      });
      const text = await response.text();
      expect(text).toContain("event: error");
      expect(text).toContain('"code":"size-mismatch"');
      const notice = await agent.waitFor((f) => f.type === "error");
      expect(notice).toMatchObject({ code: "size-mismatch" });
    }
    expect(agent.received.some((f) => f.type === "transfer-end")).toBe(false);
  });

  test("download: assembled bytes that do not match the declared checksum are refused as an integrity error", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/download?path=/x`, { method: "POST" });
    await reader.ready;
    const req = await agent.waitFor((f) => f.type === "transfer-begin");
    if (req.type !== "transfer-begin") throw new Error("unexpected frame");

    const data = new Uint8Array(1000).map((_, i) => i % 7);
    agent.send({ type: "transfer-begin", v: V, id: req.id, direction: "download", path: "/x", total: data.byteLength, checksum: "0".repeat(64) });
    agent.send({ type: "transfer-chunk", v: V, id: req.id, seq: 0, chunk: encodeBytes(data) });
    agent.send({ type: "transfer-end", v: V, id: req.id, total: data.byteLength, checksum: "0".repeat(64) });

    const failed = await reader.waitFor((e) => e.event === "error");
    expect(failed.data).toMatchObject({ code: "integrity" });
  });

  test("download: a chunk out of order fails the transfer rather than assembling a gap", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/download?path=/x`, { method: "POST" });
    await reader.ready;
    const req = await agent.waitFor((f) => f.type === "transfer-begin");
    if (req.type !== "transfer-begin") throw new Error("unexpected frame");

    agent.send({ type: "transfer-chunk", v: V, id: req.id, seq: 1, chunk: encodeBytes(new Uint8Array(3)) });
    const failed = await reader.waitFor((e) => e.event === "error");
    expect(failed.data).toMatchObject({ code: "out-of-order", message: "expected chunk 0, got 1" });
  });

  test("an error frame for a transfer ends it as failed with the agent's code", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/download?path=/missing`, { method: "POST" });
    await reader.ready;
    const req = await agent.waitFor((f) => f.type === "transfer-begin");
    if (req.type !== "transfer-begin") throw new Error("unexpected frame");

    agent.send({ type: "error", v: V, id: req.id, code: "not-found", message: "no such file" });
    const failed = await reader.waitFor((e) => e.event === "error");
    expect(failed.data).toEqual({ code: "not-found", message: "no such file" });
  });

  test("download: a real agent streams a file off its disk and the hub hands it back verified", async () => {
    const hub = await launch();
    await attachRealAgent(hub);
    const dir = mkdtempSync(join(tmpdir(), "jake-hub-download-"));
    dirs.push(dir);
    const source = join(dir, "source.bin");
    const content = new Uint8Array(randomBytes(600_000));
    await Bun.write(source, content);

    const received: Uint8Array[] = [];
    const outcome = await hubClient(hub).download(source, { onChunk: (bytes) => received.push(bytes) });

    expect(outcome).toMatchObject({ kind: "completed", total: content.byteLength, checksum: checksum(content) });
    expect(checksum(Buffer.concat(received))).toBe(checksum(content));
  });

  test("a transfer with no path is a bad request", async () => {
    const hub = await launch();
    await attach(hub.agentPort, ["transfer"]);
    const up = await control(hub, "/upload", { method: "POST", body: new Blob([new Uint8Array([1])]) });
    expect(up.status).toBe(400);
    const down = await control(hub, "/download", { method: "POST" });
    expect(down.status).toBe(400);
  });

  test("a transfer against a hub with no agent is refused", async () => {
    const hub = await launch();
    const up = await control(hub, "/upload?path=/x", { method: "POST", body: new Blob([new Uint8Array([1])]) });
    expect(up.status).toBe(409);
    const down = await control(hub, "/download?path=/x", { method: "POST" });
    expect(down.status).toBe(409);
  });
});

describe("byte streams", () => {
  // A caller's stream as far as the agent's stream-opened: its id.
  async function opened(hub: HubProcess, agent: FakeAgent): Promise<{ caller: StreamCaller; id: string }> {
    const caller = openCaller(hub, "port=22");
    const open = (await agent.waitFor((f) => f.type === "stream-open")) as { id: string; port: number };
    expect(open.port).toBe(22);
    agent.send({ type: "stream-opened", v: V, id: open.id });
    return { caller, id: open.id };
  }

  test("carries bytes both ways between a caller and the agent, acknowledging what the caller took in batches", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["stream:22"]);
    const { caller, id } = await opened(hub, agent);

    caller.ws.send(utf8.encode("SSH-2.0-client\r\n"));
    const up = (await agent.waitFor((f) => f.type === "stream-data" && f.id === id)) as { seq: number; chunk: { base64: string } };
    expect(up.seq).toBe(0);
    expect(decodeChunk(up.chunk)).toBe("SSH-2.0-client\r\n");

    const piece = randomBytes(64 * 1024);
    for (let seq = 0; seq < 5; seq += 1) agent.send({ type: "stream-data", v: V, id, seq, chunk: encodeBytes(piece) });
    await until(() => caller.bytes.length === 5 * piece.length);
    expect(caller.bytes.equals(Buffer.concat(Array(5).fill(piece)))).toBe(true);
    expect(await agent.waitFor((f) => f.type === "stream-ack" && f.id === id)).toMatchObject({ bytes: 4 * piece.length });

    expect((await (await control(hub, "/status")).json()).agents[0].streams).toEqual([id]);
    agent.send({ type: "stream-close", v: V, id, reason: "the port closed the connection" });
    expect(await caller.closed()).toEqual({ code: 1000, reason: "the port closed the connection" });
    expect((await (await control(hub, "/status")).json()).agents[0].streams).toEqual([]);
  });

  test("a port the agent does not offer is refused before anything crosses the tunnel", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["stream:22"]);
    const refused = await control(hub, "/connect?port=2222");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "port-not-offered" });
    expect(agent.received.some((f) => f.type === "stream-open")).toBe(false);
  });

  test("an open the agent refuses, or an agent that drops, ends the caller's stream as failed with the reason", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["stream:22"]);
    const refusedCaller = openCaller(hub, "port=22");
    const open = (await agent.waitFor((f) => f.type === "stream-open")) as { id: string };
    agent.send({ type: "error", v: V, id: open.id, code: "connect-failed", message: "localhost:22: Connection refused" });
    const refused = await refusedCaller.closed();
    expect(refused.code).toBe(4000);
    expect(refused.reason).toContain("[connect-failed]");

    const { caller } = await opened(hub, agent);
    agent.close();
    expect(await caller.closed()).toEqual({ code: 4000, reason: "agent connection closed" });
  });

  test("a caller that goes away closes the stream on the agent", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["stream:22"]);
    const { caller, id } = await opened(hub, agent);
    caller.ws.close();
    expect(await agent.waitFor((f) => f.type === "stream-close" && f.id === id)).toMatchObject({ reason: "the caller closed the stream" });
  });

  test("the connect mode joins a real agent's port to its standard input and output, past the window, and ends when the port closes", async () => {
    const hub = await launch();
    const port = new StandInPort(true);
    ports.push(port);
    startRealAgent(`ws://127.0.0.1:${hub.agentPort}`, SECRET, { JAKE_STREAM_PORTS: String(port.port) });
    await until(async () => (await (await control(hub, "/status")).json()).agents.length === 1);

    const connect = startHubClient(hub, { JAKE_CONTROL_TOKEN: CONTROL }, ["connect", "hass", String(port.port)]);
    clients.push(connect);
    const echoed: Uint8Array[] = [];
    let echoedBytes = 0;
    void (async () => {
      for await (const piece of connect.stdout) {
        echoed.push(piece);
        echoedBytes += piece.byteLength;
      }
    })();
    const content = randomBytes(3 * 1024 * 1024);
    connect.stdin.write(content);
    await connect.stdin.flush();
    await until(() => echoedBytes === content.length, 4_000);
    expect(checksum(Buffer.concat(echoed))).toBe(checksum(content));

    port.end();
    expect(await connect.exited).toBe(0);
  });

  test("the connect mode says why the hub refused the stream, and fails", async () => {
    const hub = await launch();
    await attach(hub.agentPort, ["exec:linux"]);
    const connect = startHubClient(hub, { JAKE_CONTROL_TOKEN: CONTROL }, ["connect", "hass-desktop"]);
    clients.push(connect);
    expect(await connect.exited).toBe(1);
    expect(await new Response(connect.stderr).text()).toContain("(HTTP 403): agent hass-desktop does not offer port 22");
  });
});

describe("streams back", () => {
  test("a listen is asked of the agent, refused for a target the hub does not allow, kept when asked for again, and listed with its state", async () => {
    const hub = await launch({ reverseTargets: "127.0.0.1:4555" });
    const agent = await attach(hub.agentPort, ["listen:4100"], "pc-a");

    const refused = await control(hub, "/listen?agent=pc-a&port=4100", { method: "POST", body: JSON.stringify({ target: "127.0.0.1:1" }) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "target-not-allowed" });
    const unoffered = await control(hub, "/listen?agent=pc-a&port=4200", { method: "POST", body: JSON.stringify({ target: "127.0.0.1:4555" }) });
    expect(await unoffered.json()).toMatchObject({ code: "port-not-offered" });

    const asked = await control(hub, "/listen?agent=pc-a&port=4100", { method: "POST", body: JSON.stringify({ target: "127.0.0.1:4555" }) });
    expect(await asked.json()).toEqual({ ok: true, standing: false });
    const listen = (await agent.waitFor((f) => f.type === "listen")) as { id: string; port: number };
    expect(listen.port).toBe(4100);
    agent.send({ type: "listening", v: V, id: listen.id });
    await until(async () => (await (await control(hub, "/listens?agent=pc-a")).json()).listens[0]?.listening === true);

    const again = await control(hub, "/listen?agent=pc-a&port=4100", { method: "POST", body: JSON.stringify({ target: "127.0.0.1:4555" }) });
    expect(await again.json()).toEqual({ ok: true, standing: true });

    expect((await control(hub, "/listen?agent=pc-a&port=4100", { method: "DELETE" })).status).toBe(200);
    await agent.waitFor((f) => f.type === "unlisten");
    expect((await (await control(hub, "/listens?agent=pc-a")).json()).listens).toEqual([]);
  });
});

describe("leave", () => {
  test("relays a leave frame to the attached agent", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const response = await control(hub, "/leave", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, agent: "hass-desktop" });

    await agent.waitFor((f) => f.type === "leave");
  });

  test("is refused when no agent is attached", async () => {
    const hub = await launch();
    const response = await control(hub, "/leave", { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).ok).toBe(false);
  });

  test("an agent told to leave is dropped and listed as departed, not as attached", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, [], "node3");
    await control(hub, "/leave?agent=node3", { method: "POST" });
    await agent.waitFor((f) => f.type === "leave");
    await agent.waitClose();

    const status = await (await control(hub, "/status")).json();
    expect(status.agents).toEqual([]);
    expect(status.departed).toEqual([{ name: "node3", departedAt: expect.any(Number) }]);
    expect(hub.stderr.some((line) => line.includes("agent node3 departed"))).toBe(true);
  });

  test("an agent's own leave, sent by its uninstaller, records it as departed until it says hello again", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jake-hub-data-"));
    dirs.push(dataDir);
    const first = await launch({ dataDir });
    const uninstalled = await attach(first.agentPort, [], "jungsu-wsl");
    await attach(first.agentPort, [], "node2");
    uninstalled.send({ type: "leave", v: V });
    await uninstalled.waitClose();
    await until(async () => (await (await control(first, "/status")).json()).departed.length === 1);

    // The record outlives the hub: a restarted hub still tells the departed agent from a dropped one.
    await first.stop();
    running.splice(running.indexOf(first), 1);
    const second = await launch({ dataDir });
    const after = await (await control(second, "/status")).json();
    expect(after.departed.map((entry: { name: string }) => entry.name)).toEqual(["jungsu-wsl"]);
    expect(after.agents).toEqual([]);

    await attach(second.agentPort, [], "jungsu-wsl");
    const back = await (await control(second, "/status")).json();
    expect(back.departed).toEqual([]);
    expect(back.agents.map((agent: { name: string }) => agent.name)).toEqual(["jungsu-wsl"]);
  });
});

// The hub executable run with a client verb, taken down after the case.
function hubClient(hub: HubProcess, credentials: Record<string, string>, args: string[]): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  const client = startHubClient(hub, credentials, args);
  clients.push(client);
  return client;
}

// A control credential for the named agents, minted by the hub executable's credential verb.
async function mint(hub: HubProcess, key: string, agents: string[]): Promise<string> {
  const minted = hubClient(hub, { JAKE_CONTROL_KEY: key }, ["credential", ...agents]);
  expect(await minted.exited).toBe(0);
  return (await new Response(minted.stdout).text()).trim();
}

function chunkOf(text: string): { bytes: number; base64: string } {
  return { bytes: Buffer.byteLength(text), base64: Buffer.from(text).toString("base64") };
}

describe("scoped control credentials", () => {
  test("a credential scoped to one agent reaches that agent alone, and one made with another key reaches nothing", async () => {
    const hub = await launch({ controlKey: "ck" });
    const own = await attach(hub.agentPort, [], "u4");
    await attach(hub.agentPort, [], "u7");
    const scoped = { Authorization: `Bearer ${await mint(hub, "ck", ["u4"])}` };

    const status = await (await control(hub, "/status", { headers: scoped })).json();
    expect(status.agents.map((a: { name: string }) => a.name)).toEqual(["u4"]);

    for (const other of ["u7", "ghost"]) {
      const refused = await control(hub, `/exec?agent=${other}`, { ...execBody("hostname"), headers: { ...scoped, "content-type": "application/json" } });
      expect(refused.status).toBe(403);
      expect((await refused.json()).code).toBe("agent-out-of-reach");
    }

    // With two attached, a request naming none goes to the one agent the credential reaches.
    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/exec`, { ...execBody("hostname"), headers: { ...scoped, "content-type": "application/json" } });
    await reader.ready;
    await own.waitFor((f) => f.type === "exec");

    const forged = { Authorization: `Bearer ${await mint(hub, "not-the-key", ["u7"])}` };
    expect((await control(hub, "/status", { headers: forged })).status).toBe(401);
  });
});

describe("the hub executable's exec", () => {
  test("streams a command's output through and exits with the agent's exit code", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, [], "u4");
    const run = hubClient(hub, { JAKE_CONTROL_TOKEN: CONTROL }, ["exec", "-a", "u4", "--shell", "linux", "--env", "A=1", "--", "ls", "-la"]);

    const exec = (await agent.waitFor((f) => f.type === "exec", 10_000)) as { id: string; shell: string; command: string; env: Record<string, string> };
    expect(exec).toMatchObject({ shell: "linux", command: "ls -la", env: { A: "1" } });
    agent.send({ type: "stdout", v: V, id: exec.id, seq: 0, chunk: chunkOf("out\n") });
    agent.send({ type: "stderr", v: V, id: exec.id, seq: 0, chunk: chunkOf("warn\n") });
    agent.send({ type: "exit", v: V, id: exec.id, code: 3, signal: null, canceled: false });

    expect(await run.exited).toBe(3);
    expect(await new Response(run.stdout).text()).toBe("out\n");
    expect(await new Response(run.stderr).text()).toBe("warn\n");
  });

  test("with a scoped credential it cannot reach another's machine, and a Ctrl-C cancels its own command", async () => {
    const hub = await launch({ controlKey: "ck" });
    const own = await attach(hub.agentPort, [], "u4");
    const other = await attach(hub.agentPort, [], "u7");
    const scoped = { JAKE_CONTROL_CREDENTIAL: await mint(hub, "ck", ["u4"]) };

    const refused = hubClient(hub, scoped, ["exec", "-a", "u7", "hostname"]);
    expect(await refused.exited).toBe(4);
    expect(await new Response(refused.stderr).text()).toContain("does not reach agent u7");
    expect(other.received.some((f) => f.type === "exec")).toBe(false);

    const run = hubClient(hub, scoped, ["exec", "sleep", "60"]);
    let printed = "";
    void (async () => {
      for await (const piece of run.stdout) printed += new TextDecoder().decode(piece);
    })();
    const exec = (await own.waitFor((f) => f.type === "exec", 10_000)) as { id: string };
    own.send({ type: "stdout", v: V, id: exec.id, seq: 0, chunk: chunkOf("running\n") });
    await until(() => printed === "running\n");

    run.kill("SIGINT");
    await own.waitFor((f) => f.type === "cancel" && (f as { id: string }).id === exec.id);
    own.send({ type: "exit", v: V, id: exec.id, code: null, signal: null, canceled: true });
    expect(await run.exited).toBe(130);
  });
});

describe("the control API carries no capability calls", () => {
  test("a /call request is not a route", async () => {
    const hub = await launch();
    await attach(hub.agentPort, ["exec:powershell"]);
    const response = await control(hub, "/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "screenshot", params: {} }),
    });
    expect(response.status).toBe(404);
  });
});

describe("liveness", () => {
  test("declares the agent dead after missed pongs and closes it", async () => {
    const hub = await launch({ pingIntervalMs: 20, missedPongLimit: 2 });

    // This agent never answers a ping, so its liveness window lapses.
    const agent = new FakeAgent(hub.agentPort, SECRET, false);
    agents.push(agent);
    expect(await agent.outcome()).toBe("open");
    agent.hello([], "hass-desktop");
    await agent.waitFor((f) => f.type === "welcome");

    await agent.waitClose(2000);
    expect(agent.closeCode).toBe(4000);
    expect(agent.closeReason).toContain("liveness");

    // It received at least one ping before being dropped.
    expect(agent.received.some((f) => f.type === "ping")).toBe(true);

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(false);
  });

  test("an agent that answers pings stays attached", async () => {
    const hub = await launch({ pingIntervalMs: 20, missedPongLimit: 2 });
    const agent = await attach(hub.agentPort, []); // autoPong on by default

    await agent.waitFor((f) => f.type === "ping"); // it is being probed
    await Bun.sleep(120); // several liveness windows pass

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(true);
  });
});

describe("traffic tail", () => {
  test("replays recent frames then follows the live feed", async () => {
    const hub = await launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/events`, { method: "GET" });
    await reader.ready;

    const run = await reader.waitFor((e) => e.event === "run");
    const status = await (await control(hub, "/status")).json();
    expect((run.data as { run: string }).run).toBe(status.run);
    // The hello that attached the agent is in the replay.
    await reader.waitFor((e) => e.event === "traffic" && (e.data as { type: string }).type === "hello");

    // A live frame after the tail is open shows up too.
    const live = openSse(`http://127.0.0.1:${hub.controlPort}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "powershell", command: "echo tail" }),
    });
    await live.ready;
    await reader.waitFor((e) => e.event === "traffic" && (e.data as { type: string }).type === "exec");
  });
});

describe("status page", () => {
  test("serves the read-only page at / without a token, and still guards the API", async () => {
    const hub = await launch();

    // The page is reachable with no Authorization header — a browser navigation cannot send one.
    const page = await fetch(`http://127.0.0.1:${hub.controlPort}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("jake console");
    // The embedded token lets the page make its own read calls over loopback.
    expect(html).toContain(CONTROL);

    // Exempting the page did not open the rest of the API: /status still demands the token.
    const status = await fetch(`http://127.0.0.1:${hub.controlPort}/status`);
    expect(status.status).toBe(401);
  });
});
