import { afterEach, describe, expect, test } from "bun:test";

import type { HubConfig } from "../src/config";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  checksum,
  decodeFrame,
  encodeBytes,
  encodeFrame,
  type Frame,
} from "../src/protocol";
import { startHub, type RunningHub, type StartHubOptions } from "../src/hub/server";
import { HubClient } from "../src/console/client";
import { HubRefusedError, WebSocketDialer } from "../src/agent/transport";

const V = PROTOCOL_VERSION;
const SECRET = "s3cr3t";
const CONTROL = "c0nsole";
const OPTS = { maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES };

function baseConfig(): HubConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    secret: SECRET,
    controlPort: 0,
    controlToken: CONTROL,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
  };
}

// Everything a test starts, torn down after it so no server or socket outlives the case.
const running: RunningHub[] = [];
const agents: FakeAgent[] = [];
const readers: SseReader[] = [];

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const agent of agents.splice(0)) agent.close();
  for (const hub of running.splice(0)) hub.close();
});

function launch(options: StartHubOptions = {}): RunningHub {
  const hub = startHub(baseConfig(), options);
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

async function control(hub: RunningHub, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${hub.controlPort}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CONTROL}`, ...(init.headers ?? {}) },
  });
}

const utf8 = new TextEncoder();
function decodeChunk(chunk: { base64: string }): string {
  return new TextDecoder().decode(Uint8Array.from(Buffer.from(chunk.base64, "base64")));
}

// --- Tests --------------------------------------------------------------------------------------

describe("agent authentication", () => {
  test("accepts an agent presenting the shared secret and records its hello", async () => {
    const hub = launch();
    const agent = await attach(hub.agentPort, ["exec", "fetch"], "hass-desktop");

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(true);
    expect(status.agents).toHaveLength(1);
    expect(status.agents[0]).toMatchObject({ name: "hass-desktop", capabilities: ["exec", "fetch"], inFlight: [] });
    expect(agent.received.some((f) => f.type === "welcome")).toBe(true);
  });

  test("rejects an agent presenting the wrong secret at the upgrade, logging it without the value", async () => {
    const lines: string[] = [];
    const hub = launch({ log: (line) => lines.push(line) });
    const agent = new FakeAgent(hub.agentPort, "wrong-secret");
    agents.push(agent);
    expect(await agent.outcome()).toBe("error");

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(false);

    const plain = await fetch(`http://127.0.0.1:${hub.agentPort}/`, { headers: { Authorization: "Bearer nope" } });
    expect(plain.status).toBe(401);
    expect(lines).toEqual(["jake hub: refused an agent connection from 127.0.0.1 (a wrong credential)"]);
  });

  test("the agent's dialer tells a refused secret apart from a hub that does not answer", async () => {
    const hub = launch({ log: () => {} });
    const events = { onMessage() {}, onClose() {}, onError() {} };
    const dialer = new WebSocketDialer(1_000);

    const refused = await dialer.dial(`ws://127.0.0.1:${hub.agentPort}`, "wrong-secret", events).catch((e) => e);
    expect(refused).toBeInstanceOf(HubRefusedError);
    expect(refused.status).toBe(401);

    const vacant = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadPort = vacant.port;
    vacant.stop(true);
    const unreachable = await dialer.dial(`ws://127.0.0.1:${deadPort}`, SECRET, events).catch((e) => e);
    expect(unreachable).toBeInstanceOf(Error);
    expect(unreachable).not.toBeInstanceOf(HubRefusedError);
  });

  test("rejects a control request without the control token", async () => {
    const hub = launch();
    const response = await fetch(`http://127.0.0.1:${hub.controlPort}/status`);
    expect(response.status).toBe(401);
  });
});

function execBody(command: string): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shell: "linux", command }) };
}

describe("many agents", () => {
  test("agents under different names attach side by side and neither displaces the other", async () => {
    const hub = launch();
    const wsl = await attach(hub.agentPort, ["exec:wsl"], "jake_wsl");
    const node2 = await attach(hub.agentPort, ["exec:linux"], "node2");

    const status = await (await control(hub, "/status")).json();
    expect(status.agents.map((a: { name: string }) => a.name)).toEqual(["jake_wsl", "node2"]);
    expect(status.agents[1]).toMatchObject({ capabilities: ["exec:linux"], inFlight: [] });
    expect(wsl.closeCode).toBeNull();
    expect(node2.closeCode).toBeNull();
  });

  test("a reconnect under a name already held replaces that connection alone", async () => {
    const hub = launch();
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
    const hub = launch();
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
    const hub = launch();
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
    const hub = launch();
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
    const hub = launch();
    const wsl = await attach(hub.agentPort, [], "jake_wsl");
    const node2 = await attach(hub.agentPort, [], "node2");

    const response = await control(hub, "/leave?agent=node2", { method: "POST" });
    expect(await response.json()).toEqual({ ok: true, agent: "node2" });
    await node2.waitFor((f) => f.type === "leave");
    expect(wsl.received.some((f) => f.type === "leave")).toBe(false);
  });

  test("the traffic log tags each frame with its agent", async () => {
    const hub = launch();
    await attach(hub.agentPort, [], "jake_wsl");
    await attach(hub.agentPort, [], "node2");

    const hellos = hub.core.trafficSince(0).filter((entry) => entry.type === "hello" || entry.type === "welcome");
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
    const hub = launch();
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
    const hub = launch();
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
    const hub = launch();
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
    const hub = launch();
    const response = await control(hub, "/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "powershell", command: "echo hi" }),
    });
    expect(response.status).toBe(409);
  });
});

describe("file transfer over the control API", () => {
  function hubClient(hub: RunningHub): HubClient {
    return new HubClient({ baseUrl: `http://127.0.0.1:${hub.controlPort}`, token: CONTROL });
  }

  test("upload: the hub chunks the file to the agent, which acknowledges the verified write", async () => {
    const hub = launch();
    const agent = await attach(hub.agentPort, ["transfer"]);
    const client = hubClient(hub);

    // Past the fixed chunk size, so more than one chunk frame must cross.
    const content = new Uint8Array(300 * 1024).map((_, i) => i % 251);
    const uploadP = client.upload("/remote/out.bin", content);

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

  test("download: the agent streams the file and the hub verifies it before completing", async () => {
    const hub = launch();
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

  test("a transfer with no path is a bad request", async () => {
    const hub = launch();
    await attach(hub.agentPort, ["transfer"]);
    const up = await control(hub, "/upload", { method: "POST", body: new Blob([new Uint8Array([1])]) });
    expect(up.status).toBe(400);
    const down = await control(hub, "/download", { method: "POST" });
    expect(down.status).toBe(400);
  });

  test("a transfer against a hub with no agent is refused", async () => {
    const hub = launch();
    const up = await control(hub, "/upload?path=/x", { method: "POST", body: new Blob([new Uint8Array([1])]) });
    expect(up.status).toBe(409);
    const down = await control(hub, "/download?path=/x", { method: "POST" });
    expect(down.status).toBe(409);
  });
});

describe("leave", () => {
  test("relays a leave frame to the attached agent", async () => {
    const hub = launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const response = await control(hub, "/leave", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, agent: "hass-desktop" });

    await agent.waitFor((f) => f.type === "leave");
  });

  test("is refused when no agent is attached", async () => {
    const hub = launch();
    const response = await control(hub, "/leave", { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).ok).toBe(false);
  });
});

describe("the control API carries no capability calls", () => {
  test("a /call request is not a route", async () => {
    const hub = launch();
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
    const hub = launch({ core: { pingIntervalMs: 20, missedPongLimit: 2 } });

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
    const hub = launch({ core: { pingIntervalMs: 20, missedPongLimit: 2 } });
    const agent = await attach(hub.agentPort, []); // autoPong on by default

    await agent.waitFor((f) => f.type === "ping"); // it is being probed
    await Bun.sleep(120); // several liveness windows pass

    const status = await (await control(hub, "/status")).json();
    expect(status.attached).toBe(true);
  });
});

describe("traffic tail", () => {
  test("replays recent frames then follows the live feed", async () => {
    const hub = launch();
    const agent = await attach(hub.agentPort, ["exec"]);

    const reader = openSse(`http://127.0.0.1:${hub.controlPort}/events`, { method: "GET" });
    await reader.ready;

    const run = await reader.waitFor((e) => e.event === "run");
    expect((run.data as { run: string }).run).toBe(hub.core.run);
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
    const hub = launch();

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
