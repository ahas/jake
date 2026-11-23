// Publishes a release's agent build to the folder the one-line install downloads from, with the deployment's own
// download address and hub written into its installers (docs/deploy.md, 「9. The agent downloads」).

import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { type Env, hubFileEnv } from "../src/config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the deployment's own settings give a publish: the addresses its installers name. */
export interface Deployment {
  /** The address the published folder is served at, which the installers download from. */
  downloadUrl: string;
  /** The hub's public address the agents dial, the installers' default hub. */
  hubUrl: string;
}

/** The installers the deployment's addresses are written into, and the mark each address stands as in them. */
const INSTALLERS = ["install.sh", "install.ps1"];
const MARKS: [string, keyof Deployment][] = [
  ["@JAKE_AGENT_DOWNLOAD_URL@", "downloadUrl"],
  ["@JAKE_PUBLIC_URL@", "hubUrl"],
];

/** The file naming the build's version, written last so whoever finds a version there finds its build. */
export const VERSION_FILE = "version.txt";

/**
 * Put one file in place under a temporary name, then rename it over the old one, so a reader sees one whole file or
 * the other; an installer with the deployment's addresses written in.
 */
function placeWhole(from: string, to: string, name: string, deployment: Deployment): void {
  const staged = join(to, `.${name}.publishing`);
  if (INSTALLERS.includes(name)) {
    let text = readFileSync(join(from, name), "utf8");
    for (const [mark, key] of MARKS) text = text.replaceAll(mark, deployment[key]);
    writeFileSync(staged, text);
  } else {
    copyFileSync(join(from, name), staged);
  }
  chmodSync(staged, 0o644);
  renameSync(staged, join(to, name));
}

/**
 * The folder to publish into and the addresses to write, from the hub's settings under the process's own; a setting
 * missing is refused, naming it, since no deployment's address stands in for another's.
 */
export function publishSettings(env: Env): { to: string; deployment: Deployment } {
  const named = (key: string, what: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is not set in the hub's settings: ${what}`);
    return value;
  };
  return {
    to: named("JAKE_PUBLISH_DIR", "the folder this machine's web server serves at JAKE_AGENT_DOWNLOAD_URL"),
    deployment: {
      downloadUrl: named("JAKE_AGENT_DOWNLOAD_URL", "the HTTPS address the published agent builds are downloaded from").replace(/\/+$/, ""),
      hubUrl: named("JAKE_PUBLIC_URL", "the wss:// address remote machines' agents dial the hub at"),
    },
  };
}

/**
 * Publish every file of the agent build in `from` into `to`, the version file last; anything else in
 * `to`, such as the desktop releases, is left as it stands. Answers the version published.
 */
export function publishAgents(from: string, to: string, deployment: Deployment): string {
  if (!existsSync(join(from, VERSION_FILE))) {
    throw new Error(`${from} holds no agent build: ${VERSION_FILE} is missing`);
  }
  const files = readdirSync(from, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== VERSION_FILE)
    .map((entry) => entry.name);
  for (const name of files) placeWhole(from, to, name, deployment);
  placeWhole(from, to, VERSION_FILE, deployment);
  return readFileSync(join(to, VERSION_FILE), "utf8").trim();
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
  const from = resolve(values.from ?? join(repoRoot, "agents"));
  try {
    const env = hubFileEnv();
    const settings = publishSettings(values.to ? { ...env, JAKE_PUBLISH_DIR: values.to } : env);
    const to = resolve(settings.to);
    if (!existsSync(to)) {
      throw new Error(`${to}, the publish folder JAKE_PUBLISH_DIR names, does not stand: a person with root makes it, owned by this account and served by this machine's web server`);
    }
    const version = publishAgents(from, to, settings.deployment);
    console.log(`published agent build ${version} from ${from} to ${to}`);
  } catch (error) {
    console.error(`jake publish failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
