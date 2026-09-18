import { describe, expect, test } from "bun:test";

import { HubClient } from "../src/console/client";
import {
  EXIT_FAILED,
  EXIT_NO_AGENT,
  EXIT_OK,
  EXIT_USAGE,
  parseArgs,
  runCli,
  type CliDeps,
} from "../src/console/cli";

// --- Fakes ----------------------------------------------------------------------------------------

// A captured console: what the CLI wrote to each stream, and a fixed clock.
interface Capture {
  out: string[];
  err: string[];
  deps: CliDeps;
}

const NOW = 1_000_000;

function capture(client: HubClient, extra?: Partial<CliDeps>): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    client,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => NOW,
    ...extra,
  };
  return { out, err, deps };
}

const encoder = new TextEncoder();

function chunkOf(text: string): { bytes: number; base64: string } {
  return { bytes: encoder.encode(text).byteLength, base64: Buffer.from(text).toString("base64") };
}

function sseEvent(event: string, data: unknown, id?: number): string {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
}

function eventStreamResponse(blocks: string[]): Response {
  return new Response(sseStream(blocks), { headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A fake hub: routes requests by path to a supplied handler, and records what the client sent.
interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function fakeHub(routes: Record<string, (recorded: Recorded) => Response>): {
  client: HubClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const recorded: Recorded = { url, method, body };
    calls.push(recorded);
    const handler = routes[path];
    if (handler === undefined) throw new Error(`no fake route for ${path}`);
    return handler(recorded);
  }) as typeof fetch;
  const client = new HubClient({ baseUrl: "http://127.0.0.1:9999", token: "T", fetch: fetchImpl });
  return { client, calls };
}

// --- parseArgs ------------------------------------------------------------------------------------

describe("parseArgs", () => {
  test("no arguments is help", () => {
    expect(parseArgs([])).toEqual({ ok: true, command: { name: "help" } });
  });

  test("--help and help both resolve to help", () => {
    expect(parseArgs(["--help"])).toEqual({ ok: true, command: { name: "help" } });
    expect(parseArgs(["help"])).toEqual({ ok: true, command: { name: "help" } });
  });

  test("status takes an optional --json flag", () => {
    expect(parseArgs(["status"])).toEqual({ ok: true, command: { name: "status", json: false } });
    expect(parseArgs(["status", "--json"])).toEqual({ ok: true, command: { name: "status", json: true } });
  });

  test("status rejects a stray positional", () => {
    const result = parseArgs(["status", "extra"]);
    expect(result.ok).toBe(false);
  });

  test("exec joins positionals into the command and defaults to powershell", () => {
    const result = parseArgs(["exec", "echo", "hi"]);
    expect(result).toEqual({
      ok: true,
      command: { name: "exec", request: { shell: "powershell", command: "echo hi", cwd: null, env: {}, distro: null } },
    });
  });

  test("exec reads shell, cwd, distro, and repeated env", () => {
    const result = parseArgs(["exec", "ls", "--shell", "wsl", "--distro", "Ubuntu", "--cwd", "/tmp", "--env", "A=1", "--env", "B=2"]);
    expect(result).toEqual({
      ok: true,
      command: {
        name: "exec",
        request: { shell: "wsl", command: "ls", cwd: "/tmp", distro: "Ubuntu", env: { A: "1", B: "2" } },
      },
    });
  });

  test("exec with no command is an error", () => {
    expect(parseArgs(["exec"]).ok).toBe(false);
    expect(parseArgs(["exec", "--shell", "wsl"]).ok).toBe(false);
  });

  test("exec rejects an unknown shell", () => {
    const result = parseArgs(["exec", "ls", "--shell", "bash"]);
    expect(result).toMatchObject({ ok: false });
  });

  test("exec rejects an unknown flag", () => {
    expect(parseArgs(["exec", "ls", "--nope"]).ok).toBe(false);
  });

  test("exec rejects an --env without an equals sign", () => {
    expect(parseArgs(["exec", "ls", "--env", "NOEQUALS"]).ok).toBe(false);
  });

  test("shot and fetch are not commands: they are shell recipes sent with exec", () => {
    expect(parseArgs(["shot"])).toEqual({ ok: false, error: "unknown command 'shot'" });
    expect(parseArgs(["fetch", "http://h/"])).toEqual({ ok: false, error: "unknown command 'fetch'" });
  });

  test("tail parses --after and rejects a bad value", () => {
    expect(parseArgs(["tail"])).toEqual({ ok: true, command: { name: "tail", after: 0 } });
    expect(parseArgs(["tail", "--after", "42"])).toEqual({ ok: true, command: { name: "tail", after: 42 } });
    expect(parseArgs(["tail", "--after", "nope"]).ok).toBe(false);
  });

  test("leave needs --yes and takes no positionals", () => {
    expect(parseArgs(["leave"])).toEqual({ ok: true, command: { name: "leave", confirmed: false } });
    expect(parseArgs(["leave", "--yes"])).toEqual({ ok: true, command: { name: "leave", confirmed: true } });
    expect(parseArgs(["leave", "now"]).ok).toBe(false);
  });

  test("an unknown command is an error", () => {
    expect(parseArgs(["frobnicate"]).ok).toBe(false);
  });
});

// --- runCli dispatch and usage --------------------------------------------------------------------

describe("runCli usage", () => {
  test("help prints the usage and exits 0", async () => {
    const { client } = fakeHub({});
    const cap = capture(client);
    const code = await runCli(["help"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(cap.out.join("")).toContain("Usage:");
  });

  test("a parse error prints to stderr and exits with the usage code", async () => {
    const { client } = fakeHub({});
    const cap = capture(client);
    const code = await runCli(["frobnicate"], cap.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(cap.err.join("")).toContain("unknown command");
  });
});

// --- status ---------------------------------------------------------------------------------------

describe("status", () => {
  const snapshot = {
    run: "hub-abc",
    attached: true,
    agent: { name: "hass-desktop", agentVersion: "0.1.0", capabilities: ["exec:powershell", "exec:wsl"], connectedAt: NOW - 65_000, lastPongAt: NOW },
    inFlight: ["c1"],
  };

  test("prints a human-readable summary", async () => {
    const { client } = fakeHub({ "/status": () => jsonResponse(snapshot) });
    const cap = capture(client);
    const code = await runCli(["status"], cap.deps);
    expect(code).toBe(EXIT_OK);
    const text = cap.out.join("");
    expect(text).toContain("attached — hass-desktop v0.1.0");
    expect(text).toContain("connected for 1m 5s");
    expect(text).toContain("exec:powershell, exec:wsl");
    expect(text).toContain("in-flight commands: c1");
  });

  test("--json prints the raw snapshot", async () => {
    const { client } = fakeHub({ "/status": () => jsonResponse(snapshot) });
    const cap = capture(client);
    const code = await runCli(["status", "--json"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(cap.out.join(""))).toMatchObject({ attached: true });
  });

  test("a hub that cannot be reached fails", async () => {
    const { client } = fakeHub({
      "/status": () => {
        throw new Error("connection refused");
      },
    });
    const cap = capture(client);
    const code = await runCli(["status"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("could not reach the hub");
  });
});

// --- The console process: a piped output arrives whole ------------------------------------------

describe("console process", () => {
  test("a large exec output piped out of the console arrives whole, with the remote exit code", async () => {
    // Eight 512 KiB chunks of base64 text, the shape a binary result takes when a recipe prints it.
    const piece = Buffer.alloc(512 * 1024, "QUJD").toString();
    const blocks = [sseEvent("started", { id: "c1" })];
    for (let seq = 0; seq < 8; seq++) blocks.push(sseEvent("stdout", { seq, chunk: chunkOf(piece) }));
    blocks.push(sseEvent("exit", { code: 3, signal: null, canceled: false }));
    const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => eventStreamResponse(blocks) });
    try {
      const proc = Bun.spawn(["bun", "src/console/main.ts", "exec", "print-it"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          JAKE_HUB_ENV: "/nonexistent/hub.env",
          JAKE_CONTROL_PORT: String(hub.port),
          JAKE_CONTROL_TOKEN: "T",
        },
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(3);
      expect(out.length).toBe(piece.length * 8);
    } finally {
      hub.stop(true);
    }
  });
});

// --- exec streaming and exit-code propagation -----------------------------------------------------

describe("exec streaming", () => {
  test("renders a streamed exec against a fake hub, in order, and exits with the remote code", async () => {
    const { client, calls } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c1" }),
          sseEvent("stdout", { seq: 0, chunk: chunkOf("one\n") }),
          sseEvent("stderr", { seq: 0, chunk: chunkOf("warn\n") }),
          sseEvent("stdout", { seq: 1, chunk: chunkOf("two\n") }),
          sseEvent("exit", { code: 0, signal: null, canceled: false }),
        ]),
    });
    const cap = capture(client);
    const code = await runCli(["exec", "echo", "hi"], cap.deps);

    expect(calls[0]?.body).toMatchObject({ shell: "powershell", command: "echo hi" });
    expect(cap.out.join("")).toBe("one\ntwo\n");
    expect(cap.err.join("")).toBe("warn\n");
    expect(code).toBe(EXIT_OK);
  });

  test("propagates a non-zero remote exit code", async () => {
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c1" }),
          sseEvent("exit", { code: 7, signal: null, canceled: false }),
        ]),
    });
    const cap = capture(client);
    expect(await runCli(["exec", "false"], cap.deps)).toBe(7);
  });

  test("a canceled run exits 130", async () => {
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c1" }),
          sseEvent("exit", { code: null, signal: "SIGTERM", canceled: true }),
        ]),
    });
    const cap = capture(client);
    expect(await runCli(["exec", "sleep", "100"], cap.deps)).toBe(130);
  });

  test("a kill with no exit code exits 1", async () => {
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c1" }),
          sseEvent("exit", { code: null, signal: "SIGKILL", canceled: false }),
        ]),
    });
    const cap = capture(client);
    expect(await runCli(["exec", "x"], cap.deps)).toBe(1);
  });

  test("an agent error during exec fails", async () => {
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([sseEvent("error", { code: "bad-shell", message: "no such shell" })]),
    });
    const cap = capture(client);
    const code = await runCli(["exec", "x"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("bad-shell");
  });

  test("a disconnect mid-run is reported and fails", async () => {
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c1" }),
          sseEvent("ended", { reason: "agent connection closed" }),
        ]),
    });
    const cap = capture(client);
    const code = await runCli(["exec", "x"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("connection ended");
  });

  test("a hub with no agent refuses exec with the no-agent code", async () => {
    const { client } = fakeHub({ "/exec": () => jsonResponse({ error: "no agent attached" }, 409) });
    const cap = capture(client);
    const code = await runCli(["exec", "x"], cap.deps);
    expect(code).toBe(EXIT_NO_AGENT);
    expect(cap.err.join("")).toContain("no agent attached");
  });

  test("binds a cancel hook once the run starts", async () => {
    const started: string[] = [];
    const { client } = fakeHub({
      "/exec": () =>
        eventStreamResponse([
          sseEvent("started", { id: "c9" }),
          sseEvent("exit", { code: 0, signal: null, canceled: false }),
        ]),
    });
    const cap = capture(client, { onExecStart: (id) => started.push(id) });
    await runCli(["exec", "x"], cap.deps);
    expect(started).toEqual(["c9"]);
  });
});

// --- leave ----------------------------------------------------------------------------------------

describe("leave", () => {
  test("without --yes it refuses and never reaches the hub", async () => {
    const { client, calls } = fakeHub({ "/leave": () => jsonResponse({ ok: true }) });
    const cap = capture(client);
    const code = await runCli(["leave"], cap.deps);
    expect(code).toBe(EXIT_USAGE);
    expect(cap.err.join("")).toContain("--yes");
    expect(calls).toHaveLength(0);
  });

  test("with --yes it sends the leave and reports success", async () => {
    const { client, calls } = fakeHub({ "/leave": () => jsonResponse({ ok: true }) });
    const cap = capture(client);
    const code = await runCli(["leave", "--yes"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(calls[0]).toMatchObject({ url: expect.stringContaining("/leave"), method: "POST" });
    expect(cap.out.join("")).toContain("leave signal sent");
  });

  test("a hub with no agent refuses with the no-agent code", async () => {
    const { client } = fakeHub({ "/leave": () => jsonResponse({ ok: false, reason: "no agent attached" }, 409) });
    const cap = capture(client);
    const code = await runCli(["leave", "--yes"], cap.deps);
    expect(code).toBe(EXIT_NO_AGENT);
    expect(cap.err.join("")).toContain("no agent attached");
  });

  test("a hub that cannot be reached fails", async () => {
    const { client } = fakeHub({
      "/leave": () => {
        throw new Error("connection refused");
      },
    });
    const cap = capture(client);
    const code = await runCli(["leave", "--yes"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("could not reach the hub");
  });
});

// --- tail -----------------------------------------------------------------------------------------

describe("tail", () => {
  test("prints each traffic entry until the stream ends", async () => {
    const { client, calls } = fakeHub({
      "/events": () =>
        eventStreamResponse([
          sseEvent("run", { run: "hub-abc" }),
          sseEvent("traffic", { id: 1, at: NOW, dir: "in", type: "hello", summary: { agent: "hass-desktop" } }, 1),
          sseEvent("traffic", { id: 2, at: NOW, dir: "out", type: "exec", summary: { id: "c1", command: "echo hi" } }, 2),
        ]),
    });
    const cap = capture(client);
    const code = await runCli(["tail"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(calls[0]?.url).toContain("after=0");
    const lines = cap.out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("<- hello");
    expect(lines[1]).toContain("-> exec");
    expect(cap.err.join("")).toContain("hub hub-abc");
  });

  test("passes --after through", async () => {
    const { client, calls } = fakeHub({ "/events": () => eventStreamResponse([sseEvent("run", { run: "h" })]) });
    const cap = capture(client);
    await runCli(["tail", "--after", "12"], cap.deps);
    expect(calls[0]?.url).toContain("after=12");
  });
});
