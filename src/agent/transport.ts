// The injected socket and timer seams the agent core reaches the outside world through.

/** One open connection to the hub, from the agent's side. The core sends over it and closes it. */
export interface Transport {
  /** Send one text frame. */
  send(text: string): void;
  /** Close the connection. Calling it more than once is harmless. */
  close(): void;
}

/** How a transport reports what arrives on it. The core supplies these; the transport calls them. */
export interface TransportEvents {
  /** A text frame arrived. */
  onMessage(raw: string): void;
  /** The connection closed, with the peer's code and reason. */
  onClose(code: number, reason: string): void;
  /** The connection failed after it had opened. A failure before open rejects `dial` instead. */
  onError(error: unknown): void;
}

/** A dial the hub answered and refused: the upgrade came back with this HTTP status. */
export class HubRefusedError extends Error {
  constructor(readonly status: number) {
    super(`the hub refused the connection (HTTP ${status})`);
    this.name = "HubRefusedError";
  }
}

/**
 * Opens one outbound connection to the hub. It resolves with a live transport once the connection
 * is open and authenticated at the upgrade, and rejects if the connection never opens — with a
 * `HubRefusedError` when the hub answered and turned the credential away, and a plain error when no
 * answer came. Every frame that arrives afterwards is delivered through the `events` the caller passed.
 */
export interface Dialer {
  dial(url: string, secret: string, events: TransportEvents): Promise<Transport>;
}

/** An opaque timer handle. The real scheduler returns the platform's; a fake returns whatever it likes. */
export type TimerHandle = unknown;

/** The clock and timers the core runs on, injected so a test can advance time deterministically. */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

// --- Real implementations ------------------------------------------------------------------------

/** The scheduler backed by the global timers, used by the agent in production. */
export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The dialer backed by a real WebSocket client. The shared secret rides as a Bearer credential on
 * the upgrade request, which is the hub authenticates before it accepts the socket. The promise
 * settles on the first of open (resolve) or a pre-open error/close (reject); once open, messages,
 * a later error, and the close all flow to the caller's events.
 *
 * A WebSocket client is told only that the upgrade failed, never the status it failed with, so a
 * pre-open failure is followed by one plain HTTP request to the same address with the same
 * credential. A 401 there means the hub is up and refused the secret; anything else leaves the
 * original failure standing.
 */
export class WebSocketDialer implements Dialer {
  constructor(private readonly probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {}

  dial(url: string, secret: string, events: TransportEvents): Promise<Transport> {
    return new Promise<Transport>((resolve, reject) => {
      // Bun's WebSocket accepts per-connection headers through a second argument the DOM lib does not
      // type; the cast is the same one the hub's tests use to send the Authorization header.
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secret}` } } as never);
      let opened = false;
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        void this.probe(url, secret).then((status) => reject(status === 401 ? new HubRefusedError(status) : error));
      };

      ws.addEventListener("open", () => {
        opened = true;
        resolve({
          send: (text) => ws.send(text),
          close: () => ws.close(),
        });
      });
      ws.addEventListener("message", (event) => {
        events.onMessage(String(event.data));
      });
      ws.addEventListener("error", (event) => {
        if (opened) {
          events.onError(event);
        } else {
          fail(new Error("the connection failed before it opened"));
        }
      });
      ws.addEventListener("close", (event) => {
        if (opened) {
          events.onClose(event.code, event.reason);
        } else {
          fail(new Error(`the connection closed before it opened (code ${event.code})`));
        }
      });
    });
  }

  /** The status a plain HTTP request to the hub's address answers with, or null when none came. */
  private async probe(url: string, secret: string): Promise<number | null> {
    try {
      const target = new URL(url);
      target.protocol = target.protocol === "wss:" ? "https:" : "http:";
      const response = await fetch(target, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      return null;
    }
  }
}
