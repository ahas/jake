// A typed client over the hub's loopback control API.

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

/**
 * How a streamed transfer ended. `completed` carries the verified byte total and checksum; `refused`
 * is the hub declining before any stream opened (no agent, or a missing path).
 */
export type TransferOutcome =
  | { kind: "completed"; total: number; checksum: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "ended"; reason: string }
  | { kind: "refused"; status: number; message: string };

/** A file to upload, and the checksum of its content that the hub declares to the agent. */
export interface UploadContent {
  /** The content, read from disk as it is sent. A `Bun.file` is one; a test passes an in-memory Blob. */
  file: Blob;
  checksum: string;
}

/** The callbacks a streamed download drives as the agent's declared size and bytes arrive. */
export interface DownloadSink {
  /** The hub has accepted the transfer and assigned it this id. */
  onStart?(id: string): void;
  /** The agent has declared the size and checksum it is about to stream. */
  onBegin?(total: number, checksum: string): void;
  /** A chunk of the file's content, already base64-decoded to its bytes. */
  onChunk(bytes: Uint8Array): void;
}

/**
 * The `agent` query parameter naming a request's target, led by `lead`; empty when no agent is named
 * and the hub is left to pick the only one attached.
 */
function agentQuery(agent: string | null, lead: "?" | "&"): string {
  return agent === null ? "" : `${lead}agent=${encodeURIComponent(agent)}`;
}

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
   * Tell the hub to erase the named agent (or the only one attached) and let it depart. The hub relays
   * the frame and the agent erases itself and drops; there is nothing to stream. A hub that cannot
   * pick the agent answers with a refusal, reported as `ok: false`.
   */
  async leave(agent: string | null = null): Promise<{ ok: boolean; status: number; reason?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/leave${agentQuery(agent, "?")}`, {
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
  async exec(request: ExecRequest, sink: ExecSink, agent: string | null = null): Promise<ExecOutcome> {
    const response = await this.fetchImpl(`${this.baseUrl}/exec${agentQuery(agent, "?")}`, {
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
   * Write a local file onto the machine at `path`. The request declares the file's length and
   * checksum and streams its bytes as the body, which the hub chunks over the tunnel as it reads them,
   * so no side holds the file whole; the outcome is the agent's verified acknowledgement. A hub with
   * no agent (or a missing path) answers with JSON rather than a stream, reported as a `refused`
   * outcome.
   */
  async upload(
    path: string,
    content: UploadContent,
    sink: { onStart?(id: string): void } = {},
    agent: string | null = null,
  ): Promise<TransferOutcome> {
    const query = `path=${encodeURIComponent(path)}&total=${content.file.size}&checksum=${content.checksum}`;
    const response = await this.fetchImpl(`${this.baseUrl}/upload?${query}${agentQuery(agent, "&")}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/octet-stream" }),
      body: content.file,
    });
    return this.consumeTransfer(response, sink);
  }

  /**
   * Read the file at `path` back from the machine, delivering the agent's declared size and each chunk
   * of content through `sink`. The outcome is `completed` only once the hub has verified the assembled
   * bytes against the declared total and checksum, so a caller writes to disk only on `completed`.
   */
  async download(path: string, sink: DownloadSink, agent: string | null = null): Promise<TransferOutcome> {
    const response = await this.fetchImpl(`${this.baseUrl}/download?path=${encodeURIComponent(path)}${agentQuery(agent, "&")}`, {
      method: "POST",
      headers: this.headers(),
    });
    return this.consumeTransfer(response, sink);
  }

  /** Drive one transfer's SSE stream, delivering begin/chunk events and returning the terminal outcome. */
  private async consumeTransfer(
    response: Response,
    sink: { onStart?(id: string): void; onBegin?(total: number, checksum: string): void; onChunk?(bytes: Uint8Array): void },
  ): Promise<TransferOutcome> {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.body === null || !contentType.startsWith("text/event-stream")) {
      let message = `the hub refused the transfer (${response.status})`;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // not JSON; keep the status-based message
      }
      return { kind: "refused", status: response.status, message };
    }

    let outcome: TransferOutcome | null = null;
    await readSse(response.body, (event) => {
      switch (event.event) {
        case "started": {
          const id = (event.data as { id?: unknown } | undefined)?.id;
          if (typeof id === "string") sink.onStart?.(id);
          return;
        }
        case "begin": {
          const data = event.data as { total?: unknown; checksum?: unknown };
          if (typeof data.total === "number" && typeof data.checksum === "string") {
            sink.onBegin?.(data.total, data.checksum);
          }
          return;
        }
        case "chunk": {
          const base64 = (event.data as { chunk?: { base64?: unknown } } | undefined)?.chunk?.base64;
          if (typeof base64 === "string") {
            sink.onChunk?.(new Uint8Array(Buffer.from(base64, "base64")));
          }
          return;
        }
        case "completed": {
          const data = event.data as { total?: unknown; checksum?: unknown };
          outcome = {
            kind: "completed",
            total: typeof data.total === "number" ? data.total : 0,
            checksum: typeof data.checksum === "string" ? data.checksum : "",
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
          if (outcome === null) {
            outcome = { kind: "ended", reason: typeof reason === "string" ? reason : "stream ended" };
          }
          return;
        }
      }
    });

    return outcome ?? { kind: "ended", reason: "the stream closed without completing" };
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
