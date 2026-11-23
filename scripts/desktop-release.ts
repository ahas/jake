// Builds the desktop app's signed installers and publishes them as a release (docs/desktop.md, 「Releases」).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  CHANNELS,
  type Channel,
  type ConsoleRead,
  DEB,
  type Installer,
  type InstallerFormat,
  NSIS,
  PLATFORM_TIME_ZONE,
  assertNewerVersion,
  assertNightlyVersion,
  channelBaseUrl,
  dayOf,
  isChannel,
  nightliesPastKept,
  nightlyVersion,
  releaseBaseUrl,
  releaseReads,
  withChannelRelease,
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

/** The release folder's console read, or null before the first release. */
function publishedRead(publishDir: string): ConsoleRead | null {
  const path = join(publishDir, "release.json");
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ConsoleRead;
}

/** The version folders standing in a channel's folder, a partial one left by a failed run passed over. */
function versionFolders(channelDir: string): string[] {
  if (!existsSync(channelDir)) {
    return [];
  }
  return readdirSync(channelDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** The update key's two files, each checked to be there; neither is read here. */
function keyFiles(keysDir: string): { keyPath: string; passwordPath: string } {
  const keyPath = join(keysDir, KEY_FILE);
  const passwordPath = join(keysDir, PASSWORD_FILE);
  for (const path of [keyPath, passwordPath]) {
    if (!existsSync(path)) {
      throw new Error(`the update key's file ${path} is missing; a release is never built unsigned`);
    }
  }
  return { keyPath, passwordPath };
}

/** The build's environment: the key handed by its path and the password by its value, neither printed. */
function signingEnv(keysDir: string): NodeJS.ProcessEnv {
  const { keyPath, passwordPath } = keyFiles(keysDir);
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

/** What one release builds: the product, the version and the configuration the CLI merges over the app's own. */
interface Release {
  readonly product: string;
  readonly version: string;
  /** The CLI's configuration arguments: a nightly's version, handed to its build alone and never written. */
  readonly override: readonly string[];
}

/** Runs one build and returns its installers, each written by this run and signed. */
function runBuild(build: Build, release: Release, env: NodeJS.ProcessEnv, targetDir: string): BuiltInstaller[] {
  console.log(`· building for ${build.name}`);
  const startedAt = Date.now();
  const cross = build.cross === null ? [] : ["--runner", build.cross.runner, "--target", build.cross.target];
  const bundles = build.formats.map((kind) => kind.format).join(",");
  const args = ["tauri", "build", "--ci", ...release.override, ...cross, "--bundles", bundles];
  const result = spawnSync("cargo", args, {
    cwd: desktopDir,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`the ${build.name} build failed (exit ${result.status ?? "signal"})`);
  }
  const bundleRoot = join(targetDir, ...(build.cross === null ? [] : [build.cross.target]), "release", "bundle");
  return build.formats.map((kind) => {
    const file = kind.fileName(release.product, release.version);
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
    options: {
      publish: { type: "string" },
      keys: { type: "string" },
      channel: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const channel = values.channel;
  if (!values.publish || !values.keys || !isChannel(channel)) {
    throw new Error(
      `usage: bun scripts/desktop-release.ts --channel <${CHANNELS.join("|")}> --publish <release folder> ` +
        "--keys <secret store folder> [--dry-run]",
    );
  }
  const publishDir = values.publish;

  const app = readAppConfig();
  const base = channelBaseUrl(releaseBaseUrl(app.endpoint), channel);
  const channelDir = channel === "stable" ? publishDir : join(publishDir, "nightly");
  const published = publishedRead(publishDir);
  const version = channelVersion(channel, app.version, published, channelDir);
  const versionDir = join(channelDir, version);
  if (existsSync(versionDir)) {
    throw new Error(`${versionDir} already exists; a published version is never written again`);
  }
  keyFiles(values.keys);
  console.log(`desktop release ${version} on ${channel} → ${channelDir}, served at ${base.href}`);
  if (values["dry-run"]) {
    console.log("dry run: nothing built or written");
    return;
  }
  const env = signingEnv(values.keys);

  const release: Release = {
    product: app.product,
    version,
    override: channel === "nightly" ? ["--config", JSON.stringify({ version })] : [],
  };
  const targetDir = cargoTargetDir();
  const installers = BUILDS.flatMap((build) => runBuild(build, release, env, targetDir));

  const { release: read, feed } = releaseReads(version, new Date(), base, installers);
  mkdirSync(channelDir, { recursive: true });
  const partialDir = join(channelDir, `.${version}.partial`);
  rmSync(partialDir, { recursive: true, force: true });
  mkdirSync(partialDir, { recursive: true });
  for (const { path, file } of installers) {
    copyFileSync(path, join(partialDir, file));
    copyFileSync(`${path}.sig`, join(partialDir, `${file}.sig`));
  }
  writeFileSync(join(partialDir, "release.json"), json(read));
  renameSync(partialDir, versionDir);
  replaceFile(join(publishDir, "release.json"), json(withChannelRelease(published, channel, read)));
  replaceFile(join(channelDir, "latest.json"), json(feed));
  if (channel === "nightly") {
    for (const old of nightliesPastKept(versionFolders(channelDir))) {
      rmSync(join(channelDir, old), { recursive: true, force: true });
      console.log(`removed the older nightly ${old}`);
    }
  }

  console.log(`\npublished ${read.version} on ${channel} at ${read.date}`);
  for (const { file, size, sha256, url } of read.files) {
    console.log(`  ${file}  ${size} bytes  sha256 ${sha256}\n    ${url}`);
  }
}

/** The version a channel's release takes, refused where the updater would not take it over what is published. */
function channelVersion(channel: Channel, configured: string, published: ConsoleRead | null, channelDir: string): string {
  if (channel === "stable") {
    assertNewerVersion(configured, published?.version ?? null);
    return configured;
  }
  const taken = [...(published?.nightly === undefined ? [] : [published.nightly.version]), ...versionFolders(channelDir)];
  const version = nightlyVersion(configured, dayOf(new Date(), PLATFORM_TIME_ZONE), taken);
  assertNightlyVersion(version, published);
  return version;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
