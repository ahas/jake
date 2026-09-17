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

// A captured console: what the CLI wrote to each stream, the files it saved, and a fixed clock.
interface Capture {
  out: string[];
  err: string[];
  files: { path: string; bytes: Uint8Array }[];
  deps: CliDeps;
}

const NOW = 1_000_000;

function capture(client: HubClient, extra?: Partial<CliDeps>): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const files: { path: string; bytes: Uint8Array }[] = [];
  const deps: CliDeps = {
    client,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    writeFile: async (path, bytes) => {
      files.push({ path, bytes });
    },
    now: () => NOW,
    ...extra,
  };
  return { out, err, files, deps };
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

  test("fetch needs a URL and parses headers", () => {
    expect(parseArgs(["fetch"]).ok).toBe(false);
    const result = parseArgs(["fetch", "http://h/x", "-X", "POST", "-H", "Accept: application/json", "-d", "hi", "-o", "out.bin"]);
    expect(result).toEqual({
      ok: true,
      command: {
        name: "fetch",
        url: "http://h/x",
        method: "POST",
        headers: { Accept: "application/json" },
        body: "hi",
        out: "out.bin",
      },
    });
  });

  test("shot parses --out and --screen", () => {
    expect(parseArgs(["shot"])).toEqual({ ok: true, command: { name: "shot", out: null, screen: null } });
    expect(parseArgs(["shot", "-o", "s.png", "--screen", "main"])).toEqual({
      ok: true,
      command: { name: "shot", out: "s.png", screen: "main" },
    });
  });

  test("tail parses --after and rejects a bad value", () => {
    expect(parseArgs(["tail"])).toEqual({ ok: true, command: { name: "tail", after: 0 } });
    expect(parseArgs(["tail", "--after", "42"])).toEqual({ ok: true, command: { name: "tail", after: 42 } });
    expect(parseArgs(["tail", "--after", "nope"]).ok).toBe(false);
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
    agent: { name: "hass-desktop", agentVersion: "0.1.0", capabilities: ["exec", "fetch"], connectedAt: NOW - 65_000, lastPongAt: NOW },
    inFlight: ["c1"],
    pendingCalls: 0,
  };

  test("prints a human-readable summary", async () => {
    const { client } = fakeHub({ "/status": () => jsonResponse(snapshot) });
    const cap = capture(client);
    const code = await runCli(["status"], cap.deps);
    expect(code).toBe(EXIT_OK);
    const text = cap.out.join("");
    expect(text).toContain("attached — hass-desktop v0.1.0");
    expect(text).toContain("connected for 1m 5s");
    expect(text).toContain("exec, fetch");
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

// --- shot -----------------------------------------------------------------------------------------

describe("shot", () => {
  test("saves the returned PNG to a path", async () => {
    const png = chunkOf("PNGDATA");
    const { client, calls } = fakeHub({
      "/call": () => jsonResponse({ ok: true, value: null, blob: { ...png, contentType: "image/png" } }),
    });
    const cap = capture(client);
    const code = await runCli(["shot", "--out", "/tmp/shot.png"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(calls[0]?.body).toMatchObject({ method: "screenshot" });
    expect(cap.files).toHaveLength(1);
    expect(cap.files[0]?.path).toBe("/tmp/shot.png");
    expect(new TextDecoder().decode(cap.files[0]?.bytes)).toBe("PNGDATA");
  });

  test("uses a timestamped default filename", async () => {
    const png = chunkOf("X");
    const { client } = fakeHub({
      "/call": () => jsonResponse({ ok: true, value: null, blob: { ...png, contentType: "image/png" } }),
    });
    const cap = capture(client);
    await runCli(["shot"], cap.deps);
    expect(cap.files[0]?.path).toBe(`shot-${NOW}.png`);
  });

  test("an agent error is surfaced", async () => {
    const { client } = fakeHub({
      "/call": () => jsonResponse({ ok: false, code: "screenshot-blocked", message: "policy" }),
    });
    const cap = capture(client);
    const code = await runCli(["shot"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("screenshot-blocked");
  });
});

// --- fetch ----------------------------------------------------------------------------------------

describe("fetch", () => {
  test("prints the status and headers to stderr and the body to stdout", async () => {
    const body = chunkOf("hello world");
    const { client, calls } = fakeHub({
      "/call": () =>
        jsonResponse({
          ok: true,
          value: { status: 200, url: "http://192.168.0.9/x", headers: { "content-type": "text/plain" } },
          blob: { ...body, contentType: "text/plain" },
        }),
    });
    const cap = capture(client);
    const code = await runCli(["fetch", "http://192.168.0.9/x"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(calls[0]?.body).toMatchObject({ method: "fetch", params: { url: "http://192.168.0.9/x", method: "GET" } });
    expect(cap.out.join("")).toBe("hello world");
    const err = cap.err.join("");
    expect(err).toContain("200 http://192.168.0.9/x");
    expect(err).toContain("content-type: text/plain");
  });

  test("writes the body to a file when --out is given", async () => {
    const body = chunkOf("filebody");
    const { client } = fakeHub({
      "/call": () => jsonResponse({ ok: true, value: { status: 200 }, blob: { ...body, contentType: "application/octet-stream" } }),
    });
    const cap = capture(client);
    const code = await runCli(["fetch", "http://h/", "--out", "/tmp/body.bin"], cap.deps);
    expect(code).toBe(EXIT_OK);
    expect(cap.files[0]?.path).toBe("/tmp/body.bin");
    expect(new TextDecoder().decode(cap.files[0]?.bytes)).toBe("filebody");
    expect(cap.out.join("")).toBe("");
  });

  test("an agent error is surfaced", async () => {
    const { client } = fakeHub({ "/call": () => jsonResponse({ ok: false, code: "fetch-failed", message: "timeout" }) });
    const cap = capture(client);
    const code = await runCli(["fetch", "http://h/"], cap.deps);
    expect(code).toBe(EXIT_FAILED);
    expect(cap.err.join("")).toContain("fetch-failed");
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
