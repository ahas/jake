// Publishes a release's agent build to the folder the one-line install downloads from.

import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The folder main-host's nginx serves as `ai.example.org/bmo/jake/`. */
const PUBLISHED_DIR = "/var/www/ahas-ai/bmo/jake";

/** The file naming the build's version, written last so whoever finds a version there finds its build. */
export const VERSION_FILE = "version.txt";

/** Put one file in place under a temporary name, then rename it over the old one, so a reader sees one whole file or the other. */
function placeWhole(from: string, to: string, name: string): void {
  const staged = join(to, `.${name}.publishing`);
  copyFileSync(join(from, name), staged);
  chmodSync(staged, 0o644);
  renameSync(staged, join(to, name));
}

/**
 * Publish every file of the agent build in `from` into `to`, the version file last; anything else in
 * `to`, such as the desktop releases, is left as it stands. Answers the version published.
 */
export function publishAgents(from: string, to: string): string {
  if (!existsSync(join(from, VERSION_FILE))) {
    throw new Error(`${from} holds no agent build: ${VERSION_FILE} is missing`);
  }
  const files = readdirSync(from, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== VERSION_FILE)
    .map((entry) => entry.name);
  for (const name of files) placeWhole(from, to, name);
  placeWhole(from, to, VERSION_FILE);
  return readFileSync(join(to, VERSION_FILE), "utf8").trim();
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
  const from = resolve(values.from ?? join(repoRoot, "agents"));
  const to = resolve(values.to ?? PUBLISHED_DIR);
  try {
    const version = publishAgents(from, to);
    console.log(`published agent build ${version} from ${from} to ${to}`);
  } catch (error) {
    console.error(`jake publish failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
