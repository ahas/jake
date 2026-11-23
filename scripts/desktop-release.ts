// Builds the desktop apps' signed installers, the remote controller's and the all-in-one's, and publishes them as one
// release (docs/desktop.md, 「Releases」).

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
  APPS,
  type AppInstallers,
  CHANNELS,
  type Channel,
  type ConsoleRead,
  DEB,
  type DesktopApp,
  type Feed,
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
  assetName,
  channelBaseUrl,
  channelTag,
  dayOf,
  feedOf,
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

/** What the release reads of an app's Tauri configuration: the crate's own with the app's overlay laid over it. */
interface AppConfig {
  readonly app: DesktopApp;
  readonly product: string;
  readonly version: string;
  readonly feed: Feed;
}

interface TauriConf {
  productName?: string;
  version?: string;
  plugins?: { updater?: { endpoints?: string[] } };
}

function readConf(file: string): TauriConf {
  return JSON.parse(readFileSync(join(desktopDir, file), "utf8")) as TauriConf;
}

function readAppConfig(app: DesktopApp): AppConfig {
  const own = readConf("tauri.conf.json");
  const overlay = app.overlay === null ? {} : readConf(app.overlay);
  const product = overlay.productName ?? own.productName;
  const version = overlay.version ?? own.version;
  const endpoint = (overlay.plugins?.updater?.endpoints ?? own.plugins?.updater?.endpoints)?.[0];
  if (!product || !version || !endpoint) {
    throw new Error(`the ${app.name}'s configuration names no product, version or updater endpoint`);
  }
  return { app, product, version, feed: feedOf(endpoint) };
}

/** Every app's configuration, all of one version and their feeds in one repository. */
function readAppConfigs(): { configs: AppConfig[]; version: string; repository: Repository } {
  const configs = APPS.map(readAppConfig);
  const versions = new Set(configs.map((config) => config.version));
  const [version] = versions;
  if (version === undefined || versions.size !== 1) {
    throw new Error(`the apps' configurations name different versions: ${[...versions].join(", ")}`);
  }
  return { configs, version, repository: repositoryOf(configs.map((config) => config.feed)) };
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

/** What one release builds: the version and the configuration the CLI merges over each app's. */
interface Release {
  readonly version: string;
  /** The CLI's configuration arguments: a nightly's version, handed to its build alone and never written. */
  readonly override: readonly string[];
}

/** Runs one build of one app and returns its installers, each written by this run and signed. */
function runBuild(
  config: AppConfig,
  build: Build,
  release: Release,
  env: NodeJS.ProcessEnv,
  targetDir: string,
): BuiltInstaller[] {
  console.log(`· building the ${config.app.name} for ${build.name}`);
  const startedAt = Date.now();
  const cross = build.cross === null ? [] : ["--runner", build.cross.runner, "--target", build.cross.target];
  const bundles = build.formats.map((kind) => kind.format).join(",");
  const overlay = config.app.overlay === null ? [] : ["--config", config.app.overlay];
  const features = config.app.features.length === 0 ? [] : ["--features", config.app.features.join(",")];
  const args = ["tauri", "build", "--ci", ...overlay, ...release.override, ...features, ...cross, "--bundles", bundles];
  const result = spawnSync("cargo", args, {
    cwd: desktopDir,
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`the ${config.app.name}'s ${build.name} build failed (exit ${result.status ?? "signal"})`);
  }
  const bundleRoot = join(targetDir, ...(build.cross === null ? [] : [build.cross.target]), "release", "bundle");
  return build.formats.map((kind) => {
    const path = join(bundleRoot, kind.bundleDir, kind.fileName(config.product, release.version));
    for (const written of [path, `${path}.sig`]) {
      if (!existsSync(written) || statSync(written).mtimeMs < startedAt) {
        throw new Error(`the ${config.app.name}'s ${build.name} build did not write ${written}`);
      }
    }
    return {
      kind,
      file: assetName(kind.fileName(config.product, release.version)),
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

/** One app's installers as this run built them. */
type AppBuilt = AppInstallers & { readonly installers: readonly BuiltInstaller[] };

/** Every installer of every app, as one list. */
const everyInstaller = (built: readonly AppBuilt[]): BuiltInstaller[] => built.flatMap((app) => app.installers);

/** Publishes the version into a mirror folder, its reads naming the mirror's own copies. */
function publishMirror(mirror: Mirror, channel: Channel, version: string, date: Date, built: readonly AppBuilt[]): void {
  const channelBase = channelBaseUrl(mirror.base, channel);
  const { release: read, feeds } = releaseReads(version, date, versionBaseUrl(channelBase, version), built);
  mkdirSync(mirror.channelDir, { recursive: true });
  const partialDir = join(mirror.channelDir, `.${version}.partial`);
  rmSync(partialDir, { recursive: true, force: true });
  mkdirSync(partialDir, { recursive: true });
  for (const { path, file } of everyInstaller(built)) {
    copyFileSync(path, join(partialDir, file));
    copyFileSync(`${path}.sig`, join(partialDir, `${file}.sig`));
  }
  writeFileSync(join(partialDir, "release.json"), json(read));
  renameSync(partialDir, join(mirror.channelDir, version));
  replaceFile(join(mirror.dir, "release.json"), json(withChannelRelease(mirror.published, channel, read)));
  for (const { file, feed } of feeds) {
    replaceFile(join(mirror.channelDir, file), json(feed));
  }
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
      "no-publish": { type: "string" },
    },
    strict: true,
  });
  const channel = values.channel;
  const keep = values["no-publish"];
  if (
    !values.keys ||
    !isChannel(channel) ||
    (values.mirror === undefined) !== (values["mirror-url"] === undefined) ||
    (keep !== undefined && (values["dry-run"] || values.mirror !== undefined))
  ) {
    throw new Error(
      `usage: bun scripts/desktop-release.ts --channel <${CHANNELS.join("|")}> --keys <secret store folder> ` +
        "[--mirror <folder> --mirror-url <its served address>] [--dry-run | --no-publish <folder>]",
    );
  }

  const { configs, version: configured, repository } = readAppConfigs();
  const commit = headCommit();
  const published = publishedRead(repository);
  const assetsNow = channel === "nightly" ? nightlyAssets(repository) : null;
  const mirror =
    values.mirror === undefined ? null : openMirror(values.mirror, values["mirror-url"] ?? "", channel);
  const version = channelVersion(channel, configured, published, mirror === null ? [] : versionFolders(mirror.channelDir));
  if (mirror !== null && existsSync(join(mirror.channelDir, version))) {
    throw new Error(`${join(mirror.channelDir, version)} already exists; a published version is never written again`);
  }
  keyFiles(values.keys);

  const tag = channelTag(channel, version);
  const files = configs.flatMap((config) =>
    BUILDS.flatMap((build) => build.formats.map((kind) => assetName(kind.fileName(config.product, version)))),
  );
  const staging = values["dry-run"] ? "<staging>" : keep ?? mkdtempSync(join(tmpdir(), "jake-desktop-release-"));
  const publication: GitHubPublication = {
    repository,
    channel,
    version,
    commit,
    assets: files.flatMap((file) => [file, `${file}.sig`]).map((file) => join(staging, file)),
    ownRead: join(staging, "release.json"),
    feeds: configs.map((config) => join(staging, config.feed.file)),
    consoleRead: join(staging, "console", "release.json"),
    stableVersion: published?.version ?? null,
    nightlyAssets: assetsNow,
  };
  const calls = githubCalls(publication);
  console.log(`desktop release ${version} on ${channel} → ${repository.slug}, tag ${tag}, from ${commit}`);
  for (const config of configs) {
    const feedUrl =
      channel === "stable"
        ? latestAssetUrl(repository, config.feed.file)
        : new URL(config.feed.file, assetBaseUrl(repository, tag));
    console.log(`  updater feed   ${feedUrl.href} (${config.app.name})`);
  }
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
    version,
    override: channel === "nightly" ? ["--config", JSON.stringify({ version })] : [],
  };
  const targetDir = cargoTargetDir();
  const built: AppBuilt[] = configs.map((config) => ({
    app: config.app,
    feedFile: config.feed.file,
    installers: BUILDS.flatMap((build) => runBuild(config, build, release, env, targetDir)),
  }));

  const date = new Date();
  const { release: read, feeds } = releaseReads(version, date, assetBaseUrl(repository, tag), built);
  mkdirSync(staging, { recursive: true });
  for (const { path, file } of everyInstaller(built)) {
    copyFileSync(path, join(staging, file));
    copyFileSync(`${path}.sig`, join(staging, `${file}.sig`));
  }
  writeFileSync(publication.ownRead, json(read));
  for (const { file, feed } of feeds) {
    writeFileSync(join(staging, file), json(feed));
  }
  mkdirSync(dirname(publication.consoleRead), { recursive: true });
  writeFileSync(publication.consoleRead, json(withChannelRelease(published, channel, read)));
  if (keep !== undefined) {
    for (const call of calls) {
      console.log(`  would run      ${shown(call)}`);
    }
    console.log(`not published: the installers, their signatures and the reads stand in ${keep}`);
    return;
  }
  for (const call of calls) {
    console.log(shown(call));
    const result = spawnSync("gh", call, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`gh failed (exit ${result.status ?? "signal"}); the release stands as far as the calls above it went`);
    }
  }
  if (mirror !== null) {
    publishMirror(mirror, channel, version, date, built);
  }
  rmSync(staging, { recursive: true, force: true });

  console.log(`\npublished ${read.version} on ${channel} at ${read.date}`);
  for (const { file, size, sha256, url } of [...read.files, ...(read.allInOne?.files ?? [])]) {
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
