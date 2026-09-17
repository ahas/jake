// The `jake` command line: the primary console surface and the handle a headless session on
// main-host drives the agent through. It parses an argument vector into one command, runs it against
// the hub client, and returns a process exit code — an exec propagates the remote command's code so
// a caller can branch on it exactly as it would on a local shell. Nothing here reads a credential
// from an argument; the token comes from the hub's config, wired in by main.

import type { ShellKind } from "../protocol";
import type { StatusSnapshot, TrafficEntry } from "../hub/core";
import type { ExecRequest, HubClient } from "./client";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NO_AGENT = 3;
export const EXIT_FAILED = 4;

export const USAGE = `jake — operator console for the remote-control agent

Usage:
  jake status [--json]              show whether the agent is attached and what is in flight
  jake exec <command...>            run a command, stream its output, exit with the remote code
      [--shell powershell|wsl] [--cwd <dir>] [--distro <name>] [--env KEY=VAL]...
  jake shot [--out <path>] [--screen <name>]      save a screenshot of the agent's desktop
  jake fetch <url>                  fetch a URL from inside the agent's network
      [--method <M>] [--header 'K: V']... [--body <data>] [--out <path>]
  jake tail [--after <id>]          follow the frames crossing the tunnel
  jake help                         show this message

The control token and port are read from the hub's configuration, never the command line.
`;

// --- The parsed command ---------------------------------------------------------------------------

export type Command =
  | { name: "help" }
  | { name: "status"; json: boolean }
  | { name: "exec"; request: ExecRequest }
  | { name: "shot"; out: string | null; screen: string | null }
  | {
      name: "fetch";
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
      out: string | null;
    }
  | { name: "tail"; after: number };

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string };

// --- Flag parsing ---------------------------------------------------------------------------------

interface FlagSpec {
  canonical: string;
  aliases: string[];
  boolean?: boolean;
  repeatable?: boolean;
}

interface ParsedFlags {
  positionals: string[];
  flags: Map<string, string[]>;
  error?: string;
}

function parseFlags(tokens: string[], specs: FlagSpec[]): ParsedFlags {
  const byName = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(`--${spec.canonical}`, spec);
    for (const alias of spec.aliases) {
      byName.set(alias.length === 1 ? `-${alias}` : `--${alias}`, spec);
    }
  }

  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (name: string, value: string): void => {
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      for (const rest of tokens.slice(i + 1)) positionals.push(rest);
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      let name = token;
      let inlineValue: string | null = null;
      const eq = token.indexOf("=");
      if (eq !== -1) {
        name = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      }
      const spec = byName.get(name);
      if (spec === undefined) {
        return { positionals, flags, error: `unknown flag ${name}` };
      }
      if (spec.boolean) {
        if (inlineValue !== null) {
          return { positionals, flags, error: `flag --${spec.canonical} takes no value` };
        }
        push(spec.canonical, "true");
        continue;
      }
      let value: string;
      if (inlineValue !== null) {
        value = inlineValue;
      } else {
        const next = tokens[i + 1];
        if (next === undefined) {
          return { positionals, flags, error: `flag --${spec.canonical} needs a value` };
        }
        value = next;
        i++;
      }
      if (!spec.repeatable && flags.has(spec.canonical)) {
        return { positionals, flags, error: `flag --${spec.canonical} was given more than once` };
      }
      push(spec.canonical, value);
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function firstFlag(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.[0];
}

// --- Argument vector to command -------------------------------------------------------------------

/** Turn the argument vector (everything after `jake`) into one command, or a stated parse error. */
export function parseArgs(argv: string[]): ParseResult {
  const command = argv[0];
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    return { ok: true, command: { name: "help" } };
  }
  const rest = argv.slice(1);

  switch (command) {
    case "status": {
      const parsed = parseFlags(rest, [{ canonical: "json", aliases: [], boolean: true }]);
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.positionals.length > 0) {
        return { ok: false, error: `status takes no arguments (got ${parsed.positionals[0]})` };
      }
      return { ok: true, command: { name: "status", json: parsed.flags.has("json") } };
    }

    case "exec": {
      const parsed = parseFlags(rest, [
        { canonical: "shell", aliases: ["s"] },
        { canonical: "cwd", aliases: [] },
        { canonical: "distro", aliases: [] },
        { canonical: "env", aliases: [], repeatable: true },
      ]);
      if (parsed.error) return { ok: false, error: parsed.error };
      const commandText = parsed.positionals.join(" ").trim();
      if (commandText === "") {
        return { ok: false, error: "exec needs a command to run" };
      }
      const shellRaw = firstFlag(parsed.flags, "shell") ?? "powershell";
      if (shellRaw !== "powershell" && shellRaw !== "wsl") {
        return { ok: false, error: `--shell must be 'powershell' or 'wsl' (got ${shellRaw})` };
      }
      const env: Record<string, string> = {};
      for (const pair of parsed.flags.get("env") ?? []) {
        const eq = pair.indexOf("=");
        if (eq === -1) {
          return { ok: false, error: `--env expects KEY=VAL (got ${pair})` };
        }
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      const request: ExecRequest = {
        shell: shellRaw as ShellKind,
        command: commandText,
        cwd: firstFlag(parsed.flags, "cwd") ?? null,
        env,
        distro: firstFlag(parsed.flags, "distro") ?? null,
      };
      return { ok: true, command: { name: "exec", request } };
    }

    case "shot": {
      const parsed = parseFlags(rest, [
        { canonical: "out", aliases: ["o"] },
        { canonical: "screen", aliases: [] },
      ]);
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.positionals.length > 0) {
        return { ok: false, error: `shot takes no positional arguments (got ${parsed.positionals[0]})` };
      }
      return {
        ok: true,
        command: {
          name: "shot",
          out: firstFlag(parsed.flags, "out") ?? null,
          screen: firstFlag(parsed.flags, "screen") ?? null,
        },
      };
    }

    case "fetch": {
      const parsed = parseFlags(rest, [
        { canonical: "method", aliases: ["X"] },
        { canonical: "header", aliases: ["H"], repeatable: true },
        { canonical: "body", aliases: ["d"] },
        { canonical: "out", aliases: ["o"] },
      ]);
      if (parsed.error) return { ok: false, error: parsed.error };
      const url = parsed.positionals[0];
      if (url === undefined) {
        return { ok: false, error: "fetch needs a URL" };
      }
      if (parsed.positionals.length > 1) {
        return { ok: false, error: `fetch takes one URL (got ${parsed.positionals.length})` };
      }
      const headers: Record<string, string> = {};
      for (const raw of parsed.flags.get("header") ?? []) {
        const colon = raw.indexOf(":");
        if (colon === -1) {
          return { ok: false, error: `--header expects 'Name: value' (got ${raw})` };
        }
        headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
      }
      return {
        ok: true,
        command: {
          name: "fetch",
          url,
          method: firstFlag(parsed.flags, "method") ?? "GET",
          headers,
          body: firstFlag(parsed.flags, "body") ?? null,
          out: firstFlag(parsed.flags, "out") ?? null,
        },
      };
    }

    case "tail": {
      const parsed = parseFlags(rest, [{ canonical: "after", aliases: [] }]);
      if (parsed.error) return { ok: false, error: parsed.error };
      let after = 0;
      const afterRaw = firstFlag(parsed.flags, "after");
      if (afterRaw !== undefined) {
        const value = Number.parseInt(afterRaw, 10);
        if (Number.isNaN(value) || value < 0) {
          return { ok: false, error: `--after must be a non-negative integer (got ${afterRaw})` };
        }
        after = value;
      }
      return { ok: true, command: { name: "tail", after } };
    }

    default:
      return { ok: false, error: `unknown command '${command}'` };
  }
}

// --- Running a command ----------------------------------------------------------------------------

export interface CliDeps {
  client: HubClient;
  /** Write to standard output. */
  out(text: string): void;
  /** Write to standard error. */
  err(text: string): void;
  /** Persist bytes to a path — a screenshot or a fetched body. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** The current wall clock, for uptime and default filenames. Injectable for tests. */
  now?(): number;
  /** Called once the hub assigns an exec an id, so main can bind Ctrl-C to a cancel. */
  onExecStart?(id: string): void;
}

/** Run one command from the argument vector and return the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.err(`jake: ${parsed.error}\n\n`);
    deps.err(USAGE);
    return EXIT_USAGE;
  }

  const command = parsed.command;
  switch (command.name) {
    case "help":
      deps.out(USAGE);
      return EXIT_OK;
    case "status":
      return runStatus(command, deps);
    case "exec":
      return runExec(command, deps);
    case "shot":
      return runShot(command, deps);
    case "fetch":
      return runFetch(command, deps);
    case "tail":
      return runTail(command, deps);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowOf(deps: CliDeps): number {
  return (deps.now ?? Date.now)();
}

function clampExit(code: number): number {
  const whole = Math.trunc(code);
  return ((whole % 256) + 256) % 256;
}

async function runStatus(command: { json: boolean }, deps: CliDeps): Promise<number> {
  let snapshot: StatusSnapshot;
  try {
    snapshot = await deps.client.status();
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  if (command.json) {
    deps.out(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    deps.out(formatStatus(snapshot, nowOf(deps)));
  }
  return EXIT_OK;
}

async function runExec(command: { request: ExecRequest }, deps: CliDeps): Promise<number> {
  const outDecoder = new TextDecoder();
  const errDecoder = new TextDecoder();

  let outcome;
  try {
    outcome = await deps.client.exec(command.request, {
      onStart: (id) => deps.onExecStart?.(id),
      onStdout: (bytes) => deps.out(outDecoder.decode(bytes, { stream: true })),
      onStderr: (bytes) => deps.err(errDecoder.decode(bytes, { stream: true })),
    });
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }

  // Flush any multibyte character left straddling the last chunk boundary.
  const outTail = outDecoder.decode();
  if (outTail !== "") deps.out(outTail);
  const errTail = errDecoder.decode();
  if (errTail !== "") deps.err(errTail);

  switch (outcome.kind) {
    case "refused":
      deps.err(`jake: ${outcome.message}\n`);
      return outcome.status === 409 ? EXIT_NO_AGENT : EXIT_FAILED;
    case "error":
      deps.err(`jake: the command failed [${outcome.code}]: ${outcome.message}\n`);
      return EXIT_FAILED;
    case "ended":
      deps.err(`jake: connection ended: ${outcome.reason}\n`);
      return EXIT_FAILED;
    case "exit":
      if (outcome.canceled) return 130;
      if (outcome.code === null) {
        deps.err(`jake: the command was killed${outcome.signal ? ` (${outcome.signal})` : ""}\n`);
        return 1;
      }
      return clampExit(outcome.code);
  }
}

async function runShot(command: { out: string | null; screen: string | null }, deps: CliDeps): Promise<number> {
  let outcome;
  try {
    outcome = await deps.client.call("screenshot", { screen: command.screen });
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  if (!outcome.ok) {
    deps.err(`jake: screenshot failed [${outcome.code}]: ${outcome.message}\n`);
    return outcome.code === "no-agent" ? EXIT_NO_AGENT : EXIT_FAILED;
  }
  if (outcome.blob === null) {
    deps.err("jake: the agent returned no image\n");
    return EXIT_FAILED;
  }
  const bytes = new Uint8Array(Buffer.from(outcome.blob.base64, "base64"));
  const path = command.out ?? `shot-${nowOf(deps)}.png`;
  try {
    await deps.writeFile(path, bytes);
  } catch (error) {
    deps.err(`jake: could not write ${path}: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  deps.out(`saved ${bytes.byteLength} bytes to ${path}\n`);
  return EXIT_OK;
}

async function runFetch(
  command: { url: string; method: string; headers: Record<string, string>; body: string | null; out: string | null },
  deps: CliDeps,
): Promise<number> {
  let outcome;
  try {
    outcome = await deps.client.call("fetch", {
      url: command.url,
      method: command.method,
      headers: command.headers,
      body: command.body,
    });
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  if (!outcome.ok) {
    deps.err(`jake: fetch failed [${outcome.code}]: ${outcome.message}\n`);
    return outcome.code === "no-agent" ? EXIT_NO_AGENT : EXIT_FAILED;
  }

  // The status line and headers go to stderr so the body alone lands on stdout when it is piped.
  const value = outcome.value as { status?: unknown; url?: unknown; headers?: unknown };
  const status = typeof value.status === "number" ? value.status : "?";
  const finalUrl = typeof value.url === "string" ? value.url : command.url;
  deps.err(`${status} ${finalUrl}\n`);
  if (value.headers !== null && typeof value.headers === "object") {
    for (const [key, headerValue] of Object.entries(value.headers as Record<string, unknown>)) {
      deps.err(`${key}: ${String(headerValue)}\n`);
    }
  }

  const body = outcome.blob === null ? new Uint8Array() : new Uint8Array(Buffer.from(outcome.blob.base64, "base64"));
  if (command.out !== null) {
    try {
      await deps.writeFile(command.out, body);
    } catch (error) {
      deps.err(`jake: could not write ${command.out}: ${errorMessage(error)}\n`);
      return EXIT_FAILED;
    }
    deps.err(`wrote ${body.byteLength} bytes to ${command.out}\n`);
  } else {
    deps.out(new TextDecoder().decode(body));
  }
  return EXIT_OK;
}

async function runTail(command: { after: number }, deps: CliDeps): Promise<number> {
  try {
    await deps.client.tail(
      command.after,
      (entry) => deps.out(`${formatTraffic(entry)}\n`),
      (run) => deps.err(`# hub ${run}\n`),
    );
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

// --- Formatting -----------------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatStatus(snapshot: StatusSnapshot, now: number): string {
  if (!snapshot.attached || snapshot.agent === null) {
    return `detached — no agent connected (hub ${snapshot.run})\n`;
  }
  const agent = snapshot.agent;
  const lines = [
    `attached — ${agent.name} v${agent.agentVersion} (hub ${snapshot.run})`,
    `  connected for ${formatDuration(now - agent.connectedAt)}`,
    `  capabilities: ${agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "(none)"}`,
    `  in-flight commands: ${snapshot.inFlight.length > 0 ? snapshot.inFlight.join(", ") : "(none)"}`,
    `  pending calls: ${snapshot.pendingCalls}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatTraffic(entry: TrafficEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 23);
  const arrow = entry.dir === "in" ? "<-" : "->";
  return `${time} ${arrow} ${entry.type} ${JSON.stringify(entry.summary)}`;
}
