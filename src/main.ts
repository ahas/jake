// The single executable's entry point: the command line chooses agent or guard.

import { runAgent } from "./agent/main";
import { runGuard } from "./guard/main";
import { GUARD_MODE_FLAG } from "./agent/anchors";

if (process.argv.includes(GUARD_MODE_FLAG)) {
  runGuard();
} else {
  runAgent();
}
