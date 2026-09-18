// A typed client over the hub's loopback control API. Every console surface — the CLI and, through
// its own inlined copy, the web page — speaks to the hub through this shape: status, a streamed
// exec, cancel, and the traffic tail. The bearer token is carried on every
// request; nothing here takes a credential from an argument. The fetch implementation is injectable
// so a test can drive the client against a fake hub without a socket.

import type { StatusSnapshot, TrafficEntry } from "../hub/core";
import type { ShellKind } from "../protocol";
import { readSse } from "./sse";

export interface HubClientOptions {
  /** The control API's base URL, e.g. http://127.0.0.1:8791. A trailing slash is tolerated. */
  baseUrl: string;
  /** The control token, presented as a Bearer credential on every request. */
  token: string;
  /** The fetch to use. Defaults to the global; a test passes a fake that returns canned responses. */
  fetch?: typeof fetch;
}

/** The shell-command request the console starts, matching the hub's exec body. */
export interface ExecRequest {
  shell: ShellKind;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  distro: string | null;
}

/** The callbacks a streamed exec drives as its output arrives. */
export interface ExecSink {
  /** The hub has accepted the command and assigned it this id. */
  onStart?(id: string): void;
  /** A chunk of standard output, already base64-decoded to its bytes. */
  onStdout(bytes: Uint8Array): void;
  /** A chunk of standard error, already base64-decoded to its bytes. */
  onStderr(bytes: Uint8Array): void;
}

/** How a streamed exec ended. `refused` is the hub declining before any stream opened (no agent). */
export type ExecOutcome =
  | { kind: "exit"; code: number | null; signal: string | null; canceled: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "ended"; reason: string }
  | { kind: "refused"; status: number; message: string };

export class HubClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HubClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Read the current connection status. */
  async status(): Promise<StatusSnapshot> {
    const response = await this.fetchImpl(`${this.baseUrl}/status`, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`status request failed with ${response.status}`);
    }
    return (await response.json()) as StatusSnapshot;
  }

  /** Ask the hub to cancel a running command. Fire-and-forget: the exit arrives on the exec stream. */
  async cancel(id: string): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/cancel`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Tell the hub to erase the agent and depart. The hub relays the frame and the agent erases itself
   * and drops; there is nothing to stream. A hub with no agent answers 409, reported as `ok: false`.
   */
  async leave(): Promise<{ ok: boolean; status: number; reason?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/leave`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: "{}",
    });
    if (response.ok) {
      return { ok: true, status: response.status };
    }
    let reason: string | undefined;
    try {
      const body = (await response.json()) as { reason?: unknown; error?: unknown };
      if (typeof body.reason === "string") reason = body.reason;
      else if (typeof body.error === "string") reason = body.error;
    } catch {
      // not JSON; the status alone carries the outcome
    }
    return { ok: false, status: response.status, reason };
  }

  /**
   * Start a command and stream its output through `sink`, resolving when the run ends. A hub that
   * declines the command (no agent attached) answers with JSON rather than an event stream; that is
   * reported as a `refused` outcome, not thrown.
   */
  async exec(request: ExecRequest, sink: ExecSink): Promise<ExecOutcome> {
    const response = await this.fetchImpl(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(request),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (response.body === null || !contentType.startsWith("text/event-stream")) {
      let message = `the hub refused the command (${response.status})`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // not JSON; keep the status-based message
      }
      return { kind: "refused", status: response.status, message };
    }

    let outcome: ExecOutcome | null = null;
    await readSse(response.body, (event) => {
      switch (event.event) {
        case "started": {
          const id = (event.data as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") sink.onStart?.(id);
          return;
        }
        case "stdout":
        case "stderr": {
          const base64 = (event.data as { chunk?: { base64?: unknown } } | undefined)?.chunk?.base64;
          if (typeof base64 === "string") {
            const bytes = new Uint8Array(Buffer.from(base64, "base64"));
            if (event.event === "stdout") sink.onStdout(bytes);
            else sink.onStderr(bytes);
          }
          return;
        }
        case "exit": {
          const data = event.data as { code?: unknown; signal?: unknown; canceled?: unknown };
          outcome = {
            kind: "exit",
            code: typeof data.code === "number" ? data.code : null,
            signal: typeof data.signal === "string" ? data.signal : null,
            canceled: data.canceled === true,
          };
          return;
        }
        case "error": {
          const data = event.data as { code?: unknown; message?: unknown };
          outcome = {
            kind: "error",
            code: typeof data.code === "string" ? data.code : "error",
            message: typeof data.message === "string" ? data.message : "",
          };
          return;
        }
        case "ended": {
          const reason = (event.data as { reason?: unknown } | undefined)?.reason;
          // A natural exit already recorded an outcome; `ended` only speaks when it is the terminal.
          if (outcome === null) {
            outcome = { kind: "ended", reason: typeof reason === "string" ? reason : "stream ended" };
          }
          return;
        }
      }
    });

    return outcome ?? { kind: "ended", reason: "the stream closed without an exit" };
  }

  /**
   * Follow the traffic tail, delivering each frame that crosses the tunnel and, first, the hub's run
   * tag so a caller can tell a hub restart from a continuation. Resolves when the stream closes.
   */
  async tail(
    after: number,
    onEntry: (entry: TrafficEntry) => void,
    onRun?: (run: string) => void,
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/events?after=${after}`, {
      headers: this.headers(),
    });
    if (response.body === null) {
      throw new Error(`tail request failed with ${response.status}`);
    }
    await readSse(response.body, (event) => {
      if (event.event === "run") {
        const run = (event.data as { run?: unknown } | undefined)?.run;
        if (typeof run === "string") onRun?.(run);
      } else if (event.event === "traffic") {
        onEntry(event.data as TrafficEntry);
      }
    });
  }
}
