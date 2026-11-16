// Builds the desktop app's signed installers and publishes them as a release (docs/desktop.md, 「Releases」).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  APPIMAGE,
  DEB,
  type Installer,
  type InstallerFormat,
  NSIS,
  assertNewerVersion,
  releaseBaseUrl,
  releaseReads,
} from "./desktop-manifest";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..", "desktop");

/** The update key's two files in the deployment's secret store (docs/desktop.md, 「Making a release」). */
const KEY_FILE = "jake-desktop-updater.key";
const PASSWORD_FILE = "jake-desktop-updater.password";

/** One `cargo tauri build` of the release: the target it builds for and the formats it bundles. */
interface Build {
  readonly name: string;
  /** The Rust target triple it cross-compiles for, with Cargo's runner for it, or null for the host's own. */
  readonly cross: { readonly target: string; readonly runner: string } | null;
  readonly formats: readonly InstallerFormat[];
}

const BUILDS: readonly Build[] = [
  { name: "Windows", cross: { target: "x86_64-pc-windows-gnu", runner: "cargo-zigbuild" }, formats: [NSIS] },
  { name: "Linux", cross: null, formats: [APPIMAGE, DEB] },
];

/** What the release reads of the app's Tauri configuration. */
interface AppConfig {
  product: string;
  version: string;
  endpoint: string;
}

function readAppConfig(): AppConfig {
  const conf = JSON.parse(readFileSync(join(desktopDir, "tauri.conf.json"), "utf8")) as {
    productName?: string;
    version?: string;
    plugins?: { updater?: { endpoints?: string[] } };
  };
  const endpoint = conf.plugins?.updater?.endpoints?.[0];
  if (!conf.productName || !conf.version || !endpoint) {
    throw new Error("tauri.conf.json names no product, version or updater endpoint");
  }
  return { product: conf.productName, version: conf.version, endpoint };
}

/** The version the release folder's console read names, or null before the first release. */
function publishedVersion(publishDir: string): string | null {
  const path = join(publishDir, "release.json");
  if (!existsSync(path)) {
    return null;
  }
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

/** The build's environment: the key handed by its path and the password by its value, neither printed. */
function signingEnv(keysDir: string): NodeJS.ProcessEnv {
  const keyPath = join(keysDir, KEY_FILE);
  const passwordPath = join(keysDir, PASSWORD_FILE);
  for (const path of [keyPath, passwordPath]) {
    if (!existsSync(path)) {
      throw new Error(`the update key's file ${path} is missing; a release is never built unsigned`);
    }
  }
  const password = readFileSync(passwordPath, "utf8").replace(/\r?\n$/, "");
  return {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: keyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
}

/** Cargo's target directory for the desktop workspace, as Cargo itself resolves it. */
function cargoTargetDir(): string {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline"], {
    cwd: desktopDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`cargo metadata failed: ${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { target_directory: string }).target_directory;
}

/** An installer as the build left it, with where it stands. */
type BuiltInstaller = Installer & { readonly path: string };

/** Runs one build and returns its installers, each written by this run and signed. */
function runBuild(build: Build, app: AppConfig, env: NodeJS.ProcessEnv, targetDir: string): BuiltInstaller[] {
  console.log(`· building for ${build.name}`);
  const startedAt = Date.now();
  const cross = build.cross === null ? [] : ["--runner", build.cross.runner, "--target", build.cross.target];
  const bundles = build.formats.map((kind) => kind.format).join(",");
  const result = spawnSync("cargo", ["tauri", "build", "--ci", ...cross, "--bundles", bundles], {
    cwd: desktopDir,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`the ${build.name} build failed (exit ${result.status ?? "signal"})`);
  }
  const bundleRoot = join(targetDir, ...(build.cross === null ? [] : [build.cross.target]), "release", "bundle");
  return build.formats.map((kind) => {
    const file = kind.fileName(app.product, app.version);
    const path = join(bundleRoot, kind.bundleDir, file);
    for (const written of [path, `${path}.sig`]) {
      if (!existsSync(written) || statSync(written).mtimeMs < startedAt) {
        throw new Error(`the ${build.name} build did not write ${written}`);
      }
    }
    return {
      kind,
      file,
      size: statSync(path).size,
      sha256: sha256Of(path),
      signature: readFileSync(`${path}.sig`, "utf8").trim(),
      path,
    };
  });
}

function sha256Of(path: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  return hasher.digest("hex");
}

/** Writes a file whole by a rename, so a reader sees the old content or the new and never part. */
function replaceFile(path: string, content: string): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, content);
  renameSync(partial, path);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function main(): void {
  const { values } = parseArgs({
    options: { publish: { type: "string" }, keys: { type: "string" } },
    strict: true,
  });
  if (!values.publish || !values.keys) {
    throw new Error("usage: bun scripts/desktop-release.ts --publish <release folder> --keys <secret store folder>");
  }
  const publishDir = values.publish;

  const app = readAppConfig();
  const base = releaseBaseUrl(app.endpoint);
  const versionDir = join(publishDir, app.version);
  assertNewerVersion(app.version, publishedVersion(publishDir));
  if (existsSync(versionDir)) {
    throw new Error(`${versionDir} already exists; a published version is never written again`);
  }
  const env = signingEnv(values.keys);
  console.log(`desktop release ${app.version} → ${publishDir}`);

  const targetDir = cargoTargetDir();
  const installers = BUILDS.flatMap((build) => runBuild(build, app, env, targetDir));

  const { release, feed } = releaseReads(app.version, new Date(), base, installers);
  const partialDir = join(publishDir, `.${app.version}.partial`);
  rmSync(partialDir, { recursive: true, force: true });
  mkdirSync(partialDir, { recursive: true });
  for (const { path, file } of installers) {
    copyFileSync(path, join(partialDir, file));
    copyFileSync(`${path}.sig`, join(partialDir, `${file}.sig`));
  }
  writeFileSync(join(partialDir, "release.json"), json(release));
  renameSync(partialDir, versionDir);
  replaceFile(join(publishDir, "release.json"), json(release));
  replaceFile(join(publishDir, "latest.json"), json(feed));

  console.log(`\npublished ${release.version} at ${release.date}`);
  for (const { file, size, sha256, url } of release.files) {
    console.log(`  ${file}  ${size} bytes  sha256 ${sha256}\n    ${url}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
