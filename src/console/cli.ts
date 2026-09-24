// The jake command line: the primary console surface.

import { isShellKind, SHELL_KINDS, streamChecksum } from "../protocol";
import type { StatusSnapshot, TrafficEntry } from "../hub/core";
import type { ExecRequest, HubClient, TransferOutcome, UploadContent } from "./client";

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NO_AGENT = 3;
export const EXIT_FAILED = 4;

export const USAGE = `jake — operator console for the bmo agent proxy

Usage:
  jake status [--json]              list every attached agent and what is in flight on it
  jake exec <command...>            run a command, stream its output, exit with the remote code
      [--shell powershell|wsl|linux] [--cwd <dir>] [--distro <name>] [--env KEY=VAL]...
  jake upload <local> <remote>      copy a local file to <remote> on the machine
  jake download <remote> <local>    copy <remote> from the machine to a local file
  jake tail [--after <id>]          follow the frames crossing the tunnel
  jake leave --yes                  erase the agent from the machine and detach for good
  jake help                         show this message

exec, upload, download and leave take --agent <name> (-a) to pick the machine by its agent name. It
may be left out while a single agent is attached; with several attached the hub refuses a request
that names none.

upload and download move a whole file over the tunnel's own frames — no scp — and verify the bytes
against a checksum before reporting success; a download is written to <local> only once verified.

Screenshots, requests from inside the agent's network, and Edge are shell commands sent with
exec; docs/recipes.md has them. The control token and port are read from the hub's configuration,
never the command line.

leave is irreversible: it deletes the executable, config, log, and autostart registrations and the
agent does not come back. It refuses without --yes.
`;

// --- The parsed command ---------------------------------------------------------------------------

export type Command =
  | { name: "help" }
  | { name: "status"; json: boolean }
  | { name: "exec"; request: ExecRequest; agent: string | null }
  | { name: "upload"; local: string; remote: string; agent: string | null }
  | { name: "download"; remote: string; local: string; agent: string | null }
  | { name: "tail"; after: number }
  | { name: "leave"; confirmed: boolean; agent: string | null };

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

/** The flag every command that reaches a machine takes to name its target agent. */
const AGENT_FLAG: FlagSpec = { canonical: "agent", aliases: ["a"] };

function agentOf(flags: Map<string, string[]>): string | null {
  return firstFlag(flags, "agent") ?? null;
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
        AGENT_FLAG,
      ]);
      if (parsed.error) return { ok: false, error: parsed.error };
      const commandText = parsed.positionals.join(" ").trim();
      if (commandText === "") {
        return { ok: false, error: "exec needs a command to run" };
      }
      const shellRaw = firstFlag(parsed.flags, "shell") ?? "powershell";
      if (!isShellKind(shellRaw)) {
        return { ok: false, error: `--shell must be one of ${SHELL_KINDS.join("|")} (got ${shellRaw})` };
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
        shell: shellRaw,
        command: commandText,
        cwd: firstFlag(parsed.flags, "cwd") ?? null,
        env,
        distro: firstFlag(parsed.flags, "distro") ?? null,
      };
      return { ok: true, command: { name: "exec", request, agent: agentOf(parsed.flags) } };
    }

    case "upload": {
      const parsed = parseFlags(rest, [AGENT_FLAG]);
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.positionals.length !== 2) {
        return { ok: false, error: "upload needs a local path and a remote path: jake upload <local> <remote>" };
      }
      return {
        ok: true,
        command: { name: "upload", local: parsed.positionals[0]!, remote: parsed.positionals[1]!, agent: agentOf(parsed.flags) },
      };
    }

    case "download": {
      const parsed = parseFlags(rest, [AGENT_FLAG]);
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.positionals.length !== 2) {
        return { ok: false, error: "download needs a remote path and a local path: jake download <remote> <local>" };
      }
      return {
        ok: true,
        command: { name: "download", remote: parsed.positionals[0]!, local: parsed.positionals[1]!, agent: agentOf(parsed.flags) },
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

    case "leave": {
      const parsed = parseFlags(rest, [{ canonical: "yes", aliases: [], boolean: true }, AGENT_FLAG]);
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.positionals.length > 0) {
        return { ok: false, error: `leave takes no arguments (got ${parsed.positionals[0]})` };
      }
      return { ok: true, command: { name: "leave", confirmed: parsed.flags.has("yes"), agent: agentOf(parsed.flags) } };
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
  /** The current wall clock, for uptime. Injectable for tests. */
  now?(): number;
  /** Called once the hub assigns an exec an id, so main can bind Ctrl-C to a cancel. */
  onExecStart?(id: string): void;
  /**
   * Open a local file for an upload, as a Blob read only as it is streamed. Defaults to the Bun file
   * API; a test injects an in-memory Blob.
   */
  openFile?(path: string): Blob;
  /** Write a local file's bytes, for a download. Defaults to the Bun file API; a test injects a fake. */
  writeFile?(path: string, data: Uint8Array): Promise<void>;
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
    case "upload":
      return runUpload(command, deps);
    case "download":
      return runDownload(command, deps);
    case "tail":
      return runTail(command, deps);
    case "leave":
      return runLeave(command, deps);
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

async function runExec(command: { request: ExecRequest; agent: string | null }, deps: CliDeps): Promise<number> {
  const outDecoder = new TextDecoder();
  const errDecoder = new TextDecoder();

  let outcome;
  try {
    outcome = await deps.client.exec(
      command.request,
      {
        onStart: (id) => deps.onExecStart?.(id),
        onStdout: (bytes) => deps.out(outDecoder.decode(bytes, { stream: true })),
        onStderr: (bytes) => deps.err(errDecoder.decode(bytes, { stream: true })),
      },
      command.agent,
    );
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
      return refusalExit(outcome.status);
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

/**
 * The exit code for a request the hub refused before anything streamed: no agent attached, or none
 * by the name given, is "no agent"; a missing agent name among several is a usage error.
 */
function refusalExit(status: number): number {
  if (status === 409 || status === 404) return EXIT_NO_AGENT;
  if (status === 400) return EXIT_USAGE;
  return EXIT_FAILED;
}

function openFileOf(deps: CliDeps): (path: string) => Blob {
  return deps.openFile ?? ((path) => Bun.file(path));
}

function writeFileOf(deps: CliDeps): (path: string, data: Uint8Array) => Promise<void> {
  return deps.writeFile ?? (async (path, data) => void (await Bun.write(path, data)));
}

/** Report a transfer that did not complete, mapping its outcome to an exit code. */
function reportTransferFailure(outcome: Exclude<TransferOutcome, { kind: "completed" }>, deps: CliDeps): number {
  switch (outcome.kind) {
    case "refused":
      deps.err(`jake: ${outcome.message}\n`);
      return refusalExit(outcome.status);
    case "error":
      deps.err(`jake: the transfer failed [${outcome.code}]: ${outcome.message}\n`);
      return EXIT_FAILED;
    case "ended":
      deps.err(`jake: connection ended: ${outcome.reason}\n`);
      return EXIT_FAILED;
  }
}

async function runUpload(command: { local: string; remote: string; agent: string | null }, deps: CliDeps): Promise<number> {
  // The file is read once here to learn its checksum, then again as it streams to the hub, so it is
  // never held whole however large it is.
  let content: UploadContent;
  try {
    const file = openFileOf(deps)(command.local);
    content = { file, checksum: await streamChecksum(file.stream()) };
  } catch (error) {
    deps.err(`jake: could not read ${command.local}: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }

  let outcome: TransferOutcome;
  try {
    outcome = await deps.client.upload(command.remote, content, {}, command.agent);
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }

  if (outcome.kind !== "completed") {
    return reportTransferFailure(outcome, deps);
  }
  deps.out(`uploaded ${command.local} -> ${command.remote} (${outcome.total} bytes)\n`);
  return EXIT_OK;
}

async function runDownload(command: { remote: string; local: string; agent: string | null }, deps: CliDeps): Promise<number> {
  const chunks: Uint8Array[] = [];

  let outcome: TransferOutcome;
  try {
    outcome = await deps.client.download(command.remote, { onChunk: (bytes) => chunks.push(bytes) }, command.agent);
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }

  // A download is written to disk only once the hub has verified the assembled bytes, so a failed or
  // partial transfer never leaves a half-written file behind.
  if (outcome.kind !== "completed") {
    return reportTransferFailure(outcome, deps);
  }
  try {
    await writeFileOf(deps)(command.local, concatChunks(chunks));
  } catch (error) {
    deps.err(`jake: downloaded but could not write ${command.local}: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
  deps.out(`downloaded ${command.remote} -> ${command.local} (${outcome.total} bytes)\n`);
  return EXIT_OK;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

async function runLeave(command: { confirmed: boolean; agent: string | null }, deps: CliDeps): Promise<number> {
  // Erasing the agent from 하스's machine cannot be undone, so it will not run on a bare `jake leave`;
  // the caller states the intent with --yes. This is the one guard the console keeps against a slip.
  if (!command.confirmed) {
    deps.err("jake: leave erases the agent and cannot be undone; re-run with --yes to confirm.\n");
    return EXIT_USAGE;
  }

  let result;
  try {
    result = await deps.client.leave(command.agent);
  } catch (error) {
    deps.err(`jake: could not reach the hub: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }

  if (!result.ok) {
    const exit = refusalExit(result.status);
    if (exit === EXIT_FAILED) {
      deps.err(`jake: the hub refused the leave (${result.status})\n`);
    } else {
      deps.err(`jake: ${result.reason ?? "no agent attached"}\n`);
    }
    return exit;
  }

  deps.out("leave signal sent — the agent will erase itself and detach.\n");
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
  if (snapshot.agents.length === 0) {
    return `detached — no agent connected (hub ${snapshot.run})\n`;
  }
  const count = snapshot.agents.length;
  const lines = [`attached — ${count} agent${count === 1 ? "" : "s"} (hub ${snapshot.run})`];
  for (const agent of snapshot.agents) {
    lines.push(
      `${agent.name} v${agent.agentVersion}`,
      `  connected for ${formatDuration(now - agent.connectedAt)}, last pong ${formatDuration(now - agent.lastPongAt)} ago`,
      `  capabilities: ${agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "(none)"}`,
      `  in-flight commands: ${agent.inFlight.length > 0 ? agent.inFlight.join(", ") : "(none)"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatTraffic(entry: TrafficEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 23);
  const arrow = entry.dir === "in" ? "<-" : "->";
  return `${time} ${entry.agent ?? "?"} ${arrow} ${entry.type} ${JSON.stringify(entry.summary)}`;
}
