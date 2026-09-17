// The hub's entry point. It reads the single environment file, starts both servers, and stays up.
// The systemd user unit that runs it permanently on main-host, and the config file it reads, are
// laid down at deployment; nothing here is compiled into a binary.

import { hubFileEnv, loadHubConfig } from "../config";
import { startHub } from "./server";

const config = loadHubConfig(hubFileEnv());
const hub = startHub(config);

console.log(`jake hub: agent server on ${config.host}:${hub.agentPort}, control API on 127.0.0.1:${hub.controlPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    hub.close();
    process.exit(0);
  });
}
