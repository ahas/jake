// A minimal Chrome DevTools Protocol client, kept apart from the browser it drives. The agent
// launches Edge with a remote-debugging endpoint and speaks CDP to it over one WebSocket: a request
// carries an id and the endpoint answers with the same id, and the endpoint also emits events that
// carry no id. This module owns that correlation — one request to one response, and a fan-out of
// events to whoever is waiting — and nothing else. It reaches the socket through a seam, so the whole
// protocol is checked on this machine with a fake socket and no browser. docs/architecture.md is the
// canonical statement of how the browser capability is shaped.

/** One open CDP WebSocket, seen the way the connection needs it. Injected so a fake stands in. */
export interface CdpSocket {
  /** Send one text frame — a serialised CDP message. */
  send(text: string): void;
  /** Close the socket. Calling it more than once is harmless. */
  close(): void;
}

/** How a socket reports what arrives. The connection supplies these; the socket calls them. */
export interface CdpSocketHandlers {
  /** One text frame arrived — a CDP response or event. */
  onMessage(raw: string): void;
  /** The socket closed, for any reason. */
  onClose(): void;
  /** The socket failed after it opened. A failure before open rejects the dial instead. */
  onError(error: unknown): void;
}

/** Opens one CDP WebSocket to a debugger URL, resolving once it is open. */
export interface CdpDialer {
  dial(url: string, handlers: CdpSocketHandlers): Promise<CdpSocket>;
}

/** A CDP error as the endpoint reports it: a numeric code and a human message. */
export interface CdpError {
  code: number;
  message: string;
}

/** The error a rejected CDP call carries, so a caller can tell a protocol error from a dead socket. */
export class CdpCallError extends Error {
  constructor(
    message: string,
    /** True when the socket was gone rather than the endpoint answering with an error. */
    readonly closed: boolean,
  ) {
    super(message);
    this.name = "CdpCallError";
  }
}

interface PendingCall {
  resolve(result: Record<string, unknown>): void;
  reject(error: CdpCallError): void;
}

interface EventWaiter {
  sessionId: string | undefined;
  match: (params: Record<string, unknown>) => boolean;
  resolve(params: Record<string, unknown>): void;
  reject(error: Error): void;
}

/** A persistent event listener the caller can remove. */
export type Unsubscribe = () => void;

interface EventListener {
  sessionId: string | undefined;
  handler: (params: Record<string, unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One CDP connection over a socket. `send` issues a command and resolves with its result or rejects
 * with a `CdpCallError`; `waitFor` resolves the next matching event; `on` registers a persistent
 * event listener. When the socket closes, every pending call and every waiter is rejected with a
 * closed error, so nothing waits forever on a browser that went away. Session-scoped messages carry a
 * `sessionId`, so a caller driving a page target through the browser endpoint (flattened) addresses
 * that session and hears only its events.
 */
export class CdpConnection {
  private socket: CdpSocket | null = null;
  private nextId = 1;
  private closedReason: string | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly listeners = new Set<EventListener>();

  /** Dial a debugger URL and return a live connection once the socket is open. */
  static async open(dialer: CdpDialer, url: string): Promise<CdpConnection> {
    const connection = new CdpConnection();
    const socket = await dialer.dial(url, {
      onMessage: (raw) => connection.handleMessage(raw),
      onClose: () => connection.handleClosed("the CDP socket closed"),
      onError: (error) => connection.handleClosed(error instanceof Error ? error.message : String(error)),
    });
    connection.socket = socket;
    return connection;
  }

  /** Whether the connection is still usable. */
  isOpen(): boolean {
    return this.socket !== null && this.closedReason === null;
  }

  /**
   * Issue one command and resolve with its `result`. A `sessionId` routes it to a page session when
   * the connection is driving a target flattened onto the browser endpoint. Rejects with a
   * `CdpCallError` — `closed` true when the socket was gone, false when the endpoint answered with a
   * protocol error.
   */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.socket === null || this.closedReason !== null) {
      return Promise.reject(new CdpCallError(this.closedReason ?? "the CDP connection is not open", true));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) {
      message.sessionId = sessionId;
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket!.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(new CdpCallError(error instanceof Error ? error.message : String(error), true));
      }
    });
  }

  /**
   * Resolve with the params of the next event named `method` (optionally on a given session) that
   * satisfies `match`. The caller bounds the wait itself; a closed socket rejects it.
   */
  waitFor(
    method: string,
    sessionId: string | undefined,
    match: (params: Record<string, unknown>) => boolean = () => true,
  ): Promise<Record<string, unknown>> {
    if (this.closedReason !== null) {
      return Promise.reject(new Error(this.closedReason));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter: EventWaiter = {
        sessionId,
        match: (params) => params.__method === method && matchOn(sessionId, params) && match(params),
        resolve: (params) => {
          this.waiters.delete(waiter);
          resolve(params);
        },
        reject: (error) => {
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Register a persistent listener for an event, returning a function that removes it. */
  on(method: string, sessionId: string | undefined, handler: (params: Record<string, unknown>) => void): Unsubscribe {
    const listener: EventListener = {
      sessionId,
      handler: (params) => {
        if (params.__method === method && matchOn(sessionId, params)) {
          handler(params);
        }
      },
    };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Close the socket and reject everything still waiting. */
  close(): void {
    const socket = this.socket;
    this.handleClosed("the CDP connection was closed");
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  // --- Incoming --------------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    if (typeof parsed.id === "number") {
      const call = this.pending.get(parsed.id);
      if (call === undefined) {
        return;
      }
      this.pending.delete(parsed.id);
      if (isRecord(parsed.error)) {
        const message = typeof parsed.error.message === "string" ? parsed.error.message : "CDP error";
        call.reject(new CdpCallError(message, false));
      } else {
        call.resolve(isRecord(parsed.result) ? parsed.result : {});
      }
      return;
    }
    if (typeof parsed.method === "string") {
      // Tag the params with their method and session so a waiter's predicate can read both from the
      // one object, and dispatch to every waiter and listener that matches.
      const params = isRecord(parsed.params) ? parsed.params : {};
      const tagged: Record<string, unknown> = { ...params, __method: parsed.method, __sessionId: parsed.sessionId };
      for (const waiter of [...this.waiters]) {
        if (waiter.match(tagged)) {
          waiter.resolve(tagged);
        }
      }
      for (const listener of [...this.listeners]) {
        listener.handler(tagged);
      }
    }
  }

  private handleClosed(reason: string): void {
    if (this.closedReason !== null) {
      return;
    }
    this.closedReason = reason;
    this.socket = null;
    for (const [, call] of [...this.pending]) {
      call.reject(new CdpCallError(reason, true));
    }
    this.pending.clear();
    for (const waiter of [...this.waiters]) {
      waiter.reject(new Error(reason));
    }
    this.waiters.clear();
    this.listeners.clear();
  }
}

/** Whether a tagged event's session matches the one a waiter or listener asked for. */
function matchOn(sessionId: string | undefined, params: Record<string, unknown>): boolean {
  if (sessionId === undefined) {
    return true;
  }
  return params.__sessionId === sessionId;
}

// --- The real socket -----------------------------------------------------------------------------

/**
 * The dialer backed by a real WebSocket to a local CDP endpoint. No credential rides the upgrade —
 * the endpoint is Edge's own remote-debugging port on loopback. The promise settles on the first of
 * open (resolve) or a pre-open error/close (reject); once open, messages, a later error, and the
 * close all flow to the handlers.
 */
export class WebSocketCdpDialer implements CdpDialer {
  dial(url: string, handlers: CdpSocketHandlers): Promise<CdpSocket> {
    return new Promise<CdpSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true;
        resolve({
          send: (text) => ws.send(text),
          close: () => ws.close(),
        });
      });
      ws.addEventListener("message", (event) => {
        handlers.onMessage(String(event.data));
      });
      ws.addEventListener("error", (event) => {
        if (opened) {
          handlers.onError(event);
        } else {
          reject(new Error("the CDP socket failed before it opened"));
        }
      });
      ws.addEventListener("close", () => {
        if (opened) {
          handlers.onClose();
        } else {
          reject(new Error("the CDP socket closed before it opened"));
        }
      });
    });
  }
}
