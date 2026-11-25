// Cross-compiles the agent for Windows and Linux and assembles the install layout.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

/** The layout's folder: `--out <dir>`, as a deployment gives its release's, else `dist/jake`. */
const layoutDir = resolve(
  parseArgs({ options: { out: { type: "string" } } }).values.out ?? join(repoRoot, "dist", "jake"),
);

/** The file of the layout that names the version stamped into its binaries, read by the hub and the updater. */
const VERSION_FILE = "version.txt";

/**
 * The per-platform executables the layout ships: a Rust target and the name it lands under. The Linux
 * binary links musl statically, so it runs on any distribution or WSL whatever its C library; zig is
 * the linker and C compiler for both targets, so neither needs a toolchain of its own.
 */
const BINARIES: ReadonlyArray<{ target: string; outName: string }> = [
  { target: "x86_64-pc-windows-gnu", outName: "jake.exe" },
  { target: "x86_64-unknown-linux-musl", outName: "jake" },
];

/**
 * Derive the build version: the set's version a deployment hands the build as `BMO_VERSION`, read off the git tags
 * (bmo-chat's docs/conventions.md, 「Versions」), else the package's placeholder version, plus the git short hash and
 * a dirty marker, so two builds of one day's nightly stay apart.
 */
async function readVersion(): Promise<string> {
  const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as { version?: string };
  const base = process.env.BMO_VERSION || (pkg.version ?? "0.0.0");
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

/** Cargo's target directory for the workspace, as Cargo itself resolves it. */
function cargoTargetDir(): string {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed: ${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { target_directory: string }).target_directory;
}

/** Cross-compile the agent for one target into the layout, stamping the version in. */
function compile(target: string, outName: string, version: string, targetDir: string): void {
  const result = spawnSync(
    "cargo",
    ["zigbuild", "--release", "--offline", "--package", "jake-agent", "--target", target],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, JAKE_VERSION: version } },
  );
  if (result.status !== 0) {
    throw new Error(`compile failed for ${target} (exit ${result.status ?? "signal"})`);
  }
  const built = join(targetDir, target, "release", outName);
  if (!existsSync(built)) {
    throw new Error(`compile reported success but ${built} is missing`);
  }
  cpSync(built, join(layoutDir, outName));
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

  const targetDir = cargoTargetDir();
  for (const { target, outName } of BINARIES) {
    console.log(`· compiling ${outName} (${target})`);
    compile(target, outName, version, targetDir);
  }

  console.log("· placing the example config, the install scripts, and the systemd unit");
  place("agent.env.example", "agent.env.example");
  place("scripts/install.ps1", "install.ps1");
  place("scripts/uninstall.ps1", "uninstall.ps1");
  place("scripts/install.sh", "install.sh");
  place("scripts/uninstall.sh", "uninstall.sh");
  place("jake-agent.service", "jake-agent.service");
  place("docs/install.md", "INSTALL.md");
  writeFileSync(join(layoutDir, VERSION_FILE), `${version}\n`);

  console.log("\nlayout:");
  for (const { outName } of BINARIES) {
    console.log(`  ${outName}  ${sizeOf(join(layoutDir, outName))}`);
  }
  console.log(`  agent.env.example, install.ps1, uninstall.ps1, install.sh, uninstall.sh, jake-agent.service, INSTALL.md, ${VERSION_FILE}`);
  console.log(`\ndone. version ${version} stamped into each executable.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
