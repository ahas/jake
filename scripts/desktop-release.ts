// Builds the desktop app's signed installers and publishes them as a release (docs/desktop.md, 「Releases」).

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  APPIMAGE,
  CHANNELS,
  type Channel,
  type ConsoleRead,
  DEB,
  type GhCall,
  type GitHubPublication,
  type Installer,
  type InstallerFormat,
  NIGHTLY_TAG,
  NSIS,
  PLATFORM_TIME_ZONE,
  type Repository,
  assertNewerVersion,
  assertNightlyVersion,
  assetBaseUrl,
  channelBaseUrl,
  channelTag,
  dayOf,
  githubCalls,
  isChannel,
  latestAssetUrl,
  nightliesPastKept,
  nightlyVersion,
  releaseReads,
  repositoryOf,
  stableTag,
  versionBaseUrl,
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

/** One `gh` call, its output kept; `gh` is found on the PATH. */
function gh(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`gh could not be run: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const notFound = (stderr: string): boolean => /not found/i.test(stderr);

/** The console's read the latest stable release carries, or null before the first release. */
function publishedRead(repository: Repository): ConsoleRead | null {
  const latest = gh(["release", "view", "--repo", repository.slug, "--json", "tagName"]);
  if (latest.status !== 0) {
    if (notFound(latest.stderr)) {
      return null;
    }
    throw new Error(`gh could not read ${repository.slug}'s latest release: ${latest.stderr.trim()}`);
  }
  const { tagName } = JSON.parse(latest.stdout) as { tagName: string };
  if (!tagName.startsWith(stableTag(""))) {
    throw new Error(`${repository.slug}'s latest release ${tagName} is not the desktop app's`);
  }
  const read = gh(["release", "download", tagName, "--repo", repository.slug, "--pattern", "release.json", "--output", "-"]);
  if (read.status !== 0) {
    throw new Error(`the latest release ${tagName} holds no release.json: ${read.stderr.trim()}`);
  }
  return JSON.parse(read.stdout) as ConsoleRead;
}

/** The names of the assets the nightly pre-release holds, or null where it does not stand yet. */
function nightlyAssets(repository: Repository): string[] | null {
  const nightly = gh(["release", "view", NIGHTLY_TAG, "--repo", repository.slug, "--json", "assets"]);
  if (nightly.status !== 0) {
    if (notFound(nightly.stderr)) {
      return null;
    }
    throw new Error(`gh could not read ${repository.slug}'s ${NIGHTLY_TAG}: ${nightly.stderr.trim()}`);
  }
  return (JSON.parse(nightly.stdout) as { assets: { name: string }[] }).assets.map((asset) => asset.name);
}

/** The commit the checkout stands on, which a new release's tag points at. */
function headCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: desktopDir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git rev-parse failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** A folder the release is also published to, served at its own address: the reads and the installers kept there. */
interface Mirror {
  readonly dir: string;
  readonly base: URL;
  readonly channelDir: string;
  readonly published: ConsoleRead | null;
}

function openMirror(dir: string, served: string, channel: Channel): Mirror {
  const base = new URL(served.endsWith("/") ? served : `${served}/`);
  const path = join(dir, "release.json");
  const published = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ConsoleRead) : null;
  if (channel === "nightly" && published === null) {
    throw new Error(`the mirror ${dir} holds no stable release; a nightly follows a release`);
  }
  return { dir, base, channelDir: channel === "stable" ? dir : join(dir, "nightly"), published };
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

/** A `gh` call as a shell would read it, for the dry run's print. */
const shown = (call: GhCall): string => ["gh", ...call].map((arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");

/** Publishes the version into a mirror folder, its reads naming the mirror's own copies. */
function publishMirror(mirror: Mirror, channel: Channel, version: string, date: Date, installers: readonly BuiltInstaller[]): void {
  const channelBase = channelBaseUrl(mirror.base, channel);
  const { release: read, feed } = releaseReads(version, date, versionBaseUrl(channelBase, version), installers);
  mkdirSync(mirror.channelDir, { recursive: true });
  const partialDir = join(mirror.channelDir, `.${version}.partial`);
  rmSync(partialDir, { recursive: true, force: true });
  mkdirSync(partialDir, { recursive: true });
  for (const { path, file } of installers) {
    copyFileSync(path, join(partialDir, file));
    copyFileSync(`${path}.sig`, join(partialDir, `${file}.sig`));
  }
  writeFileSync(join(partialDir, "release.json"), json(read));
  renameSync(partialDir, join(mirror.channelDir, version));
  replaceFile(join(mirror.dir, "release.json"), json(withChannelRelease(mirror.published, channel, read)));
  replaceFile(join(mirror.channelDir, "latest.json"), json(feed));
  if (channel === "nightly") {
    for (const old of nightliesPastKept(versionFolders(mirror.channelDir))) {
      rmSync(join(mirror.channelDir, old), { recursive: true, force: true });
      console.log(`removed the mirror's older nightly ${old}`);
    }
  }
  console.log(`mirrored ${version} on ${channel} into ${mirror.channelDir}, served at ${channelBase.href}`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      channel: { type: "string" },
      keys: { type: "string" },
      mirror: { type: "string" },
      "mirror-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  const channel = values.channel;
  if (!values.keys || !isChannel(channel) || (values.mirror === undefined) !== (values["mirror-url"] === undefined)) {
    throw new Error(
      `usage: bun scripts/desktop-release.ts --channel <${CHANNELS.join("|")}> --keys <secret store folder> ` +
        "[--mirror <folder> --mirror-url <its served address>] [--dry-run]",
    );
  }

  const app = readAppConfig();
  const repository = repositoryOf(app.endpoint);
  const commit = headCommit();
  const published = publishedRead(repository);
  const assetsNow = channel === "nightly" ? nightlyAssets(repository) : null;
  const mirror =
    values.mirror === undefined ? null : openMirror(values.mirror, values["mirror-url"] ?? "", channel);
  const version = channelVersion(channel, app.version, published, mirror === null ? [] : versionFolders(mirror.channelDir));
  if (mirror !== null && existsSync(join(mirror.channelDir, version))) {
    throw new Error(`${join(mirror.channelDir, version)} already exists; a published version is never written again`);
  }
  keyFiles(values.keys);

  const tag = channelTag(channel, version);
  const files = BUILDS.flatMap((build) => build.formats.map((kind) => kind.fileName(app.product, version)));
  const staging = values["dry-run"] ? "<staging>" : mkdtempSync(join(tmpdir(), "jake-desktop-release-"));
  const publication: GitHubPublication = {
    repository,
    channel,
    version,
    commit,
    assets: files.flatMap((file) => [file, `${file}.sig`]).map((file) => join(staging, file)),
    ownRead: join(staging, "release.json"),
    feed: join(staging, "latest.json"),
    consoleRead: join(staging, "console", "release.json"),
    stableVersion: published?.version ?? null,
    nightlyAssets: assetsNow,
  };
  const calls = githubCalls(publication);
  const feedUrl = channel === "stable" ? latestAssetUrl(repository, "latest.json") : new URL("latest.json", assetBaseUrl(repository, tag));
  console.log(`desktop release ${version} on ${channel} → ${repository.slug}, tag ${tag}, from ${commit}`);
  console.log(`  updater feed   ${feedUrl.href}`);
  console.log(`  console read   ${latestAssetUrl(repository, "release.json").href}`);
  for (const file of files) {
    console.log(`  installer      ${new URL(encodeURIComponent(file), assetBaseUrl(repository, tag)).href}`);
  }
  if (mirror !== null) {
    console.log(`  mirror         ${mirror.channelDir}, served at ${channelBaseUrl(mirror.base, channel).href}`);
  }
  if (values["dry-run"]) {
    for (const call of calls) {
      console.log(`  would run      ${shown(call)}`);
    }
    console.log("dry run: nothing built, uploaded or written");
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

  const date = new Date();
  const { release: read, feed } = releaseReads(version, date, assetBaseUrl(repository, tag), installers);
  for (const { path, file } of installers) {
    copyFileSync(path, join(staging, file));
    copyFileSync(`${path}.sig`, join(staging, `${file}.sig`));
  }
  writeFileSync(publication.ownRead, json(read));
  writeFileSync(publication.feed, json(feed));
  mkdirSync(dirname(publication.consoleRead), { recursive: true });
  writeFileSync(publication.consoleRead, json(withChannelRelease(published, channel, read)));
  for (const call of calls) {
    console.log(shown(call));
    const result = spawnSync("gh", call, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`gh failed (exit ${result.status ?? "signal"}); the release stands as far as the calls above it went`);
    }
  }
  if (mirror !== null) {
    publishMirror(mirror, channel, version, date, installers);
  }
  rmSync(staging, { recursive: true, force: true });

  console.log(`\npublished ${read.version} on ${channel} at ${read.date}`);
  for (const { file, size, sha256, url } of read.files) {
    console.log(`  ${file}  ${size} bytes  sha256 ${sha256}\n    ${url}`);
  }
}

/** The version a channel's release takes, refused where the updater would not take it over what is published. */
function channelVersion(channel: Channel, configured: string, published: ConsoleRead | null, mirrored: readonly string[]): string {
  if (channel === "stable") {
    assertNewerVersion(configured, published?.version ?? null);
    return configured;
  }
  const taken = [...(published?.nightly === undefined ? [] : [published.nightly.version]), ...mirrored];
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
