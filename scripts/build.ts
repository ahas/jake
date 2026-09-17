// The build step. It cross-compiles the two Windows binaries from main-host — no Windows toolchain
// is needed to produce them — and assembles the install layout the installer copies into place. Run
// it with `bun scripts/build.ts`.
//
// The output is dist/jake/, a single folder, not a single file: the browser capability cannot be
// compiled into the executable (docs/architecture.md states why), so the sidecar travels beside the
// exes as its own directory, and the screenshot fallback nircmd.exe and the example config sit
// alongside. The installer, itself carried in the layout, copies this folder to a per-user location.
//
// nircmd.exe is fetched here rather than committed, because a third-party binary does not belong in
// the tree. The fetch is best-effort: nircmd is only the screenshot fallback for the case where
// machine policy blocks the PowerShell path, so a build with no network still produces a valid
// layout — it just leaves that fallback for the installer or 하스 to supply later.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const distDir = join(repoRoot, "dist");
const layoutDir = join(distDir, "jake");
const target = "bun-windows-x64";

// The x64 nircmd zip, matching the x64 target the binaries are built for.
const NIRCMD_URL = "https://www.nirsoft.net/utils/nircmd-x64.zip";

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

/** Cross-compile one entry point to a Windows exe in the layout, stamping the version in. */
function compile(entry: string, outName: string, version: string): void {
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
    throw new Error(`compile failed for ${entry} (exit ${result.status ?? "signal"})`);
  }
  if (!existsSync(out)) {
    throw new Error(`compile reported success but ${out} is missing`);
  }
}

/** Copy the sidecar into the layout, leaving out the downloaded browser (installed on the box). */
function copySidecar(): void {
  const src = join(repoRoot, "sidecar");
  const dest = join(layoutDir, "sidecar");
  cpSync(src, dest, {
    recursive: true,
    // Never carry the downloaded browser into the layout — it is hundreds of megabytes and is
    // fetched on 하스's box at install time. Everything else, including node_modules, travels.
    filter: (from) => {
      const rel = from.slice(src.length + 1);
      return rel !== "browsers" && !rel.startsWith(`browsers${sep}`);
    },
  });
}

/** Fetch nircmd.exe into the layout, best-effort. Returns whether it landed. */
async function fetchNircmd(): Promise<boolean> {
  const zipPath = join(distDir, "nircmd-x64.zip");
  const exePath = join(layoutDir, "nircmd.exe");
  try {
    const response = await fetch(NIRCMD_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await Bun.write(zipPath, await response.arrayBuffer());
    const unzip = spawnSync("unzip", ["-o", "-j", zipPath, "nircmd.exe", "-d", layoutDir], {
      encoding: "utf8",
    });
    if (unzip.status !== 0 || !existsSync(exePath)) {
      throw new Error(`unzip failed: ${unzip.stderr ?? ""}`);
    }
    return true;
  } catch (error) {
    console.warn(
      `  ! nircmd.exe not bundled (${error instanceof Error ? error.message : String(error)}).\n` +
        `    The screenshot PowerShell path still works; only the policy-blocked fallback is absent.\n` +
        `    The installer can fetch it later, or drop nircmd.exe beside jake-agent.exe by hand.`,
    );
    return false;
  } finally {
    if (existsSync(zipPath)) {
      rmSync(zipPath, { force: true });
    }
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

  console.log("· compiling jake-agent.exe");
  compile("src/agent/main.ts", "jake-agent.exe", version);
  console.log("· compiling jake-guard.exe");
  compile("src/guard/main.ts", "jake-guard.exe", version);

  console.log("· copying the browser sidecar");
  copySidecar();

  console.log("· fetching nircmd.exe (screenshot fallback)");
  const gotNircmd = await fetchNircmd();

  console.log("· placing the example config and the install scripts");
  place("agent.env.example", "agent.env.example");
  place("scripts/install.ps1", "install.ps1");
  place("scripts/uninstall.ps1", "uninstall.ps1");
  place("docs/install.md", "INSTALL.md");

  console.log("\nlayout:");
  for (const name of ["jake-agent.exe", "jake-guard.exe"]) {
    console.log(`  ${name}  ${sizeOf(join(layoutDir, name))}`);
  }
  console.log(`  sidecar/  (node_modules bundled, browser downloaded at install)`);
  console.log(`  nircmd.exe  ${gotNircmd ? sizeOf(join(layoutDir, "nircmd.exe")) : "(not bundled)"}`);
  console.log(`  agent.env.example, install.ps1, uninstall.ps1, INSTALL.md`);
  console.log(`\ndone. version ${version} stamped into both binaries.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
