// The single executable's entry point. The build compiles this one file into jake.exe, and the
// command line chooses which half of the self-healing pair this process is: the guard-mode flag runs
// the small supervisor, and its absence runs the agent that carries the tunnel and the shell.
// One deliverable, two run modes — the installer anchors the same executable twice, once with the
// flag and once without, so two processes come up and watch each other. docs/architecture.md is the
// canonical statement of the shape.

import { runAgent } from "./agent/main";
import { runGuard } from "./guard/main";
import { GUARD_MODE_FLAG } from "./agent/anchors";

if (process.argv.includes(GUARD_MODE_FLAG)) {
  runGuard();
} else {
  runAgent();
}
