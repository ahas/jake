// The `jake` console entry point. It finds the hub's control port and token — from the hub's
// environment file, the same one the hub reads, never from an argument — builds a client against the
// loopback control API, and runs one command. It stays this thin: the parsing and every command live
// in cli.ts, so they can be tested without a process. The compiled agent has nothing to do with this;
// the console runs on main-host beside the hub.

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
    writeFile: async (path, data) => {
      await Bun.write(path, data);
    },
    // Ctrl-C during an exec cancels the remote command, so the run stops like a local one would.
    onExecStart: (id) => {
      process.on("SIGINT", () => {
        void client.cancel(id);
      });
    },
  });
}

main().then((code) => {
  process.exit(code);
});
