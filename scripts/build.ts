// Cross-compiles the agent for Windows and Linux and assembles the install layout.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const distDir = join(repoRoot, "dist");
const layoutDir = join(distDir, "jake");

/** The per-platform executables the layout ships: a bun compile target and the name it lands under. */
const BINARIES: ReadonlyArray<{ target: string; outName: string }> = [
  { target: "bun-windows-x64", outName: "jake.exe" },
  { target: "bun-linux-x64", outName: "jake" },
];

/** Derive the build version: the package version, plus the git short hash and a dirty marker. */
async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as { version?: string };
  const base = pkg.version ?? "0.0.0";
  const hash = git(["rev-parse", "--short", "HEAD"]);
  if (hash === null) {
    return base;
  }
  const dirty = git(["status", "--porcelain"]);
  const suffix = dirty !== null && dirty.trim() !== "" ? ".dirty" : "";
  return `${base}+g${hash}${suffix}`;
}

/** Run a git command and return its trimmed stdout, or null when git is unavailable or fails. */
function git(args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return result.stdout.trim();
}

/** Cross-compile one entry point for one target into the layout, stamping the version in. */
function compile(entry: string, target: string, outName: string, version: string): void {
  const out = join(layoutDir, outName);
  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=${target}`,
      "--define",
      `__JAKE_VERSION__=${JSON.stringify(version)}`,
      "--outfile",
      out,
      join(repoRoot, entry),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`compile failed for ${entry} → ${target} (exit ${result.status ?? "signal"})`);
  }
  if (!existsSync(out)) {
    throw new Error(`compile reported success but ${out} is missing`);
  }
}

/** Copy one repo file into the layout under a chosen name. */
function place(relSource: string, destName: string): void {
  cpSync(join(repoRoot, relSource), join(layoutDir, destName));
}

/** A human-readable size for the manifest. */
function sizeOf(path: string): string {
  const bytes = statSync(path).size;
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

async function main(): Promise<void> {
  const version = await readVersion();
  console.log(`jake build ${version} → ${layoutDir}`);

  rmSync(layoutDir, { recursive: true, force: true });
  mkdirSync(layoutDir, { recursive: true });

  for (const { target, outName } of BINARIES) {
    console.log(`· compiling ${outName} (${target})`);
    compile("src/main.ts", target, outName, version);
  }

  console.log("· placing the example config, the install scripts, and the systemd unit");
  place("agent.env.example", "agent.env.example");
  place("scripts/install.ps1", "install.ps1");
  place("scripts/uninstall.ps1", "uninstall.ps1");
  place("scripts/install.sh", "install.sh");
  place("scripts/uninstall.sh", "uninstall.sh");
  place("jake-agent.service", "jake-agent.service");
  place("docs/install.md", "INSTALL.md");

  console.log("\nlayout:");
  for (const { outName } of BINARIES) {
    console.log(`  ${outName}  ${sizeOf(join(layoutDir, outName))}`);
  }
  console.log(`  agent.env.example, install.ps1, uninstall.ps1, install.sh, uninstall.sh, jake-agent.service, INSTALL.md`);
  console.log(`\ndone. version ${version} stamped into each executable.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
