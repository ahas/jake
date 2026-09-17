// The seams the agent core reaches the outside world through. The socket it dials over and the
// timers it schedules on are both injected here rather than reached for directly, so the core's
// reconnect, heartbeat, and dispatch can be driven on Linux by a fake socket and a fake clock. The
// real implementations at the bottom of this file are the only place a live WebSocket or the global
// timers are touched.

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

/**
 * Opens one outbound connection to the hub. It resolves with a live transport once the connection
 * is open and authenticated at the upgrade, and rejects if the connection never opens. Every frame
 * that arrives afterwards is delivered through the `events` the caller passed.
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

/**
 * The dialer backed by a real WebSocket client. The shared secret rides as a Bearer credential on
 * the upgrade request, which is the hub authenticates before it accepts the socket. The promise
 * settles on the first of open (resolve) or a pre-open error/close (reject); once open, messages,
 * a later error, and the close all flow to the caller's events.
 */
export class WebSocketDialer implements Dialer {
  dial(url: string, secret: string, events: TransportEvents): Promise<Transport> {
    return new Promise<Transport>((resolve, reject) => {
      // Bun's WebSocket accepts per-connection headers through a second argument the DOM lib does not
      // type; the cast is the same one the hub's tests use to send the Authorization header.
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${secret}` } } as never);
      let opened = false;

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
          reject(new Error("the connection failed before it opened"));
        }
      });
      ws.addEventListener("close", (event) => {
        if (opened) {
          events.onClose(event.code, event.reason);
        } else {
          reject(new Error(`the connection closed before it opened (code ${event.code})`));
        }
      });
    });
  }
}
