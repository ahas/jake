// The jake console entry point.

import { hubFileEnv, loadConsoleConfig, type ConsoleConfig } from "../config";
import { HubClient } from "./client";
import { EXIT_OK, EXIT_USAGE, USAGE, runCli } from "./cli";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Help needs no configuration, so it answers even on a box where the hub env is not set up.
  const first = argv[0];
  if (first === undefined || first === "help" || first === "-h" || first === "--help") {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  let config: ConsoleConfig;
  try {
    config = loadConsoleConfig(hubFileEnv());
  } catch (error) {
    process.stderr.write(`jake: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  const client = new HubClient({
    baseUrl: `http://127.0.0.1:${config.controlPort}`,
    token: config.controlToken,
  });

  return runCli(argv, {
    client,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    // Ctrl-C during an exec cancels the remote command, so the run stops like a local one would.
    onExecStart: (id) => {
      process.on("SIGINT", () => {
        void client.cancel(id);
      });
    },
  });
}

// The exit code is set rather than forced: a forced exit ends the process while piped stdout is
// still draining, and a large output — a base64 payload piped into a decoder — would arrive cut short.
main().then((code) => {
  process.exitCode = code;
});
