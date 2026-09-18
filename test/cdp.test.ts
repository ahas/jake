import { describe, expect, test } from "bun:test";

import { CdpCallError, CdpConnection, type CdpDialer, type CdpSocket, type CdpSocketHandlers } from "../src/agent/cdp";

// A fake CDP socket: it records the frames sent to it and lets the test deliver frames back through
// the handlers the connection registered, standing in for a real WebSocket to Edge's debugger.
class FakeSocket implements CdpSocket {
  readonly sent: string[] = [];
  closed = false;
  handlers!: CdpSocketHandlers;
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver one frame from the endpoint. */
  deliver(message: unknown): void {
    this.handlers.onMessage(JSON.stringify(message));
  }
  /** The last frame the connection sent, parsed. */
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!) as Record<string, unknown>;
  }
}

class FakeDialer implements CdpDialer {
  readonly socket = new FakeSocket();
  dial(_url: string, handlers: CdpSocketHandlers): Promise<CdpSocket> {
    this.socket.handlers = handlers;
    return Promise.resolve(this.socket);
  }
}

async function connect(): Promise<{ conn: CdpConnection; socket: FakeSocket }> {
  const dialer = new FakeDialer();
  const conn = await CdpConnection.open(dialer, "ws://127.0.0.1:0/devtools/browser/x");
  return { conn, socket: dialer.socket };
}

describe("CdpConnection — commands", () => {
  test("correlates a command to its response by id", async () => {
    const { conn, socket } = await connect();
    const promise = conn.send("Target.createTarget", { url: "about:blank" });
    const sent = socket.lastSent();
    expect(sent.method).toBe("Target.createTarget");
    expect(sent.params).toEqual({ url: "about:blank" });
    socket.deliver({ id: sent.id, result: { targetId: "T1" } });
    expect(await promise).toEqual({ targetId: "T1" });
  });

  test("routes a session-scoped command by sessionId", async () => {
    const { conn, socket } = await connect();
    const promise = conn.send("Page.enable", {}, "S1");
    expect(socket.lastSent().sessionId).toBe("S1");
    socket.deliver({ id: socket.lastSent().id, sessionId: "S1", result: {} });
    expect(await promise).toEqual({});
  });

  test("an error response rejects with the endpoint's message", async () => {
    const { conn, socket } = await connect();
    const promise = conn.send("Page.navigate", { url: "nope" });
    socket.deliver({ id: socket.lastSent().id, error: { code: -32000, message: "bad url" } });
    await expect(promise).rejects.toMatchObject({ message: "bad url" });
  });

  test("a rejected command carries whether the socket was gone", async () => {
    const { conn, socket } = await connect();
    const errored = conn.send("A", {});
    socket.deliver({ id: socket.lastSent().id, error: { code: 1, message: "protocol" } });
    const protocolError = await errored.catch((e: unknown) => e);
    expect(protocolError).toBeInstanceOf(CdpCallError);
    expect((protocolError as CdpCallError).closed).toBe(false);
  });
});

describe("CdpConnection — events", () => {
  test("waitFor resolves the next matching event", async () => {
    const { conn, socket } = await connect();
    const waited = conn.waitFor("Page.loadEventFired", "S1");
    socket.deliver({ method: "Page.loadEventFired", sessionId: "S1", params: { timestamp: 5 } });
    const params = await waited;
    expect(params.timestamp).toBe(5);
  });

  test("waitFor ignores an event on another session", async () => {
    const { conn, socket } = await connect();
    let resolved = false;
    void conn.waitFor("Page.loadEventFired", "S1").then(() => {
      resolved = true;
    });
    socket.deliver({ method: "Page.loadEventFired", sessionId: "S2", params: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
  });

  test("a persistent listener receives events until it is removed", async () => {
    const { conn, socket } = await connect();
    const seen: unknown[] = [];
    const off = conn.on("Network.responseReceived", "S1", (p) => seen.push(p.type));
    socket.deliver({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Document" } });
    socket.deliver({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Image" } });
    off();
    socket.deliver({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Script" } });
    expect(seen).toEqual(["Document", "Image"]);
  });
});

describe("CdpConnection — closing", () => {
  test("closing rejects every pending command and waiter", async () => {
    const { conn, socket } = await connect();
    const call = conn.send("A", {});
    const event = conn.waitFor("Page.loadEventFired", undefined);
    conn.close();
    expect(socket.closed).toBe(true);
    const callError = await call.catch((e: unknown) => e);
    expect(callError).toBeInstanceOf(CdpCallError);
    expect((callError as CdpCallError).closed).toBe(true);
    await expect(event).rejects.toBeInstanceOf(Error);
    expect(conn.isOpen()).toBe(false);
  });

  test("the socket closing on its own rejects a later send as closed", async () => {
    const { conn, socket } = await connect();
    socket.handlers.onClose();
    const error = await conn.send("A", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdpCallError);
    expect((error as CdpCallError).closed).toBe(true);
  });
});
