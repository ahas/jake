// Builds the hub CLI when asked and fails unless both documented paths hold an executable.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--build")) {
  const result = spawnSync("bash", [join(repoRoot, "scripts", "install-hub-cli.sh")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`the hub CLI install failed (exit ${result.status ?? "signal"})`);
    process.exit(1);
  }
}

const cliPaths: ReadonlyArray<{ path: string; what: string }> = [
  { path: join(repoRoot, "target", "release", "jake-hub"), what: "the built hub CLI" },
  { path: join(homedir(), ".local", "bin", "jake-hub"), what: "the installed hub CLI" },
];

let missing = false;
for (const { path, what } of cliPaths) {
  if (!existsSync(path)) {
    console.error(`${what} is missing: ${path}`);
    missing = true;
  } else if ((statSync(path).mode & 0o111) === 0) {
    console.error(`${what} is not executable: ${path}`);
    missing = true;
  }
}

if (missing) {
  process.exit(1);
}

console.log(`hub CLI present at ${cliPaths.map(({ path }) => path).join(" and ")}`);
