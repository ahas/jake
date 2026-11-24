// Builds the desktop apps' signed installers and publishes them: an official release to GitHub, a test release to
// the test update server.

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
  type ReleaseRead,
  type Repository,
  type UpdateApp,
  type UpdateCall,
  type UpdateServer,
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
  shownCall,
  stableTag,
  updateEndpoint,
  updateServerCalls,
  updateServerOf,
  versionBaseUrl,
  withChannelRelease,
} from "./desktop-manifest";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..", "desktop");

/** The update key's two files in the deployment's secret store (docs/desktop.md, 「Making a release」). */
const KEY_FILE = "jake-desktop-updater.key";
const PASSWORD_FILE = "jake-desktop-updater.password";
/** The test update server's publisher's file in the deployment's secret store, which bmo-update's install writes. */
const PUBLISHER_FILE = "update-publisher.env";

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

/** Whether the repository is public: GitHub's releases of a private one answer no one outside it. */
function repositoryIsPublic(repository: Repository): boolean {
  const view = gh(["repo", "view", repository.slug, "--json", "visibility"]);
  if (view.status !== 0) {
    throw new Error(`gh could not read ${repository.slug}'s visibility: ${view.stderr.trim()}`);
  }
  return (JSON.parse(view.stdout) as { visibility: string }).visibility === "PUBLIC";
}

/** The update server the publisher's file names, read without printing a value. */
function readUpdateServer(file: string): UpdateServer {
  if (!existsSync(file)) {
    throw new Error(`the update server's publisher's file ${file} is missing; bmo-update's install writes it`);
  }
  return updateServerOf(readFileSync(file, "utf8"), file);
}

/** The newest live or withdrawn version of a product on a channel of the update server, or null where none stands. */
async function newestOnServer(server: UpdateServer, product: string, channel: Channel): Promise<string | null> {
  const address = new URL(`products/${encodeURIComponent(product)}/releases?channel=${channel}&limit=1`, server.publishAddress);
  const answer = await fetch(address);
  if (answer.status === 404) {
    return null;
  }
  if (!answer.ok) {
    throw new Error(`the update server answered ${answer.status} to ${address.href}: ${await answer.text()}`);
  }
  const page = (await answer.json()) as { items: { version: string }[] };
  return page.items[0]?.version ?? null;
}

/** Makes one call of the update server's publication, an installer's declaration or bytes read from what was built. */
async function callUpdateServer(server: UpdateServer, call: UpdateCall, installers: ReadonlyMap<string, BuiltInstaller>): Promise<void> {
  const headers: Record<string, string> = { authorization: `Bearer ${server.token}` };
  let body: BodyInit | undefined;
  if (call.installer !== undefined) {
    const installer = installers.get(call.installer.file);
    if (installer === undefined) {
      throw new Error(`no installer ${call.installer.file} was built`);
    }
    if (call.installer.part === "content") {
      headers["content-type"] = "application/octet-stream";
      body = Bun.file(installer.path);
    } else {
      headers["content-type"] = "application/json";
      const { platform, arch, format } = installer.kind;
      body = JSON.stringify({ platform, arch, format, size: installer.size, sha256: installer.sha256, signature: installer.signature });
    }
  } else if (call.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(call.json);
  }
  const answer = await fetch(new URL(call.path, server.publishAddress), { method: call.method, headers, body });
  if (!answer.ok) {
    throw new Error(`the update server answered ${answer.status} to ${call.method} ${call.path}: ${await answer.text()}`);
  }
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
  /** The CLI's configuration arguments for an app: a test build's update server endpoint and a nightly's version,
   * handed to its build alone and never written. */
  override(config: AppConfig): readonly string[];
}

/**
 * Runs one build of one app and returns its installers, each written by this run, signed, and copied with its
 * signature into `collected` under its published name at once, since the next app's build of the same format
 * clears the bundle folder it was written into.
 */
function runBuild(
  config: AppConfig,
  build: Build,
  release: Release,
  env: NodeJS.ProcessEnv,
  targetDir: string,
  collected: string,
): BuiltInstaller[] {
  console.log(`· building the ${config.app.name} for ${build.name}`);
  const startedAt = Date.now();
  const cross = build.cross === null ? [] : ["--runner", build.cross.runner, "--target", build.cross.target];
  const bundles = build.formats.map((kind) => kind.format).join(",");
  const overlay = config.app.overlay === null ? [] : ["--config", config.app.overlay];
  const features = config.app.features.length === 0 ? [] : ["--features", config.app.features.join(",")];
  const args = ["tauri", "build", "--ci", ...overlay, ...release.override(config), ...features, ...cross, "--bundles", bundles];
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
    const file = assetName(kind.fileName(config.product, release.version));
    const kept = join(collected, file);
    copyFileSync(path, kept);
    copyFileSync(`${path}.sig`, `${kept}.sig`);
    return {
      kind,
      file,
      size: statSync(kept).size,
      sha256: sha256Of(kept),
      signature: readFileSync(`${kept}.sig`, "utf8").trim(),
      path: kept,
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      channel: { type: "string" },
      test: { type: "boolean", default: false },
      keys: { type: "string" },
      publisher: { type: "string" },
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
      `usage: bun scripts/desktop-release.ts --channel <${CHANNELS.join("|")}> [--test] --keys <secret store folder> ` +
        "[--publisher <file>] [--mirror <folder> --mirror-url <its served address>] [--dry-run | --no-publish <folder>]",
    );
  }

  const { configs, version: configured, repository } = readAppConfigs();
  const commit = headCommit();
  const mirror =
    values.mirror === undefined ? null : openMirror(values.mirror, values["mirror-url"] ?? "", channel);
  const mirrored = mirror === null ? [] : versionFolders(mirror.channelDir);
  const target: Target = values.test
    ? await testTarget(readUpdateServer(values.publisher ?? join(values.keys, PUBLISHER_FILE)), configs, channel, commit)
    : officialTarget(repository, configs, channel, commit);
  const version = channelVersion(channel, configured, target.published, mirrored);
  if (mirror !== null && existsSync(join(mirror.channelDir, version))) {
    throw new Error(`${join(mirror.channelDir, version)} already exists; a published version is never written again`);
  }
  keyFiles(values.keys);
  if (target.refusal !== null && !values["dry-run"] && keep === undefined) {
    throw new Error(target.refusal);
  }

  const files = configs.flatMap((config) =>
    BUILDS.flatMap((build) => build.formats.map((kind) => assetName(kind.fileName(config.product, version)))),
  );
  const staging = values["dry-run"] ? "<staging>" : keep ?? mkdtempSync(join(tmpdir(), "jake-desktop-release-"));
  const plan = target.plan(version, files, staging);
  console.log(`desktop ${target.kind} release ${version} on ${channel} → ${target.destination}, from ${commit}`);
  for (const config of configs) {
    console.log(`  endpoint       ${target.endpoint(config)} (${config.app.name})`);
  }
  for (const line of plan.lines) {
    console.log(`  ${line}`);
  }
  if (mirror !== null) {
    console.log(`  mirror         ${mirror.channelDir}, served at ${channelBaseUrl(mirror.base, channel).href}`);
  }
  const printCalls = (): void => {
    for (const call of plan.calls) {
      console.log(`  would ${call.verb.padEnd(9)}${call.line}`);
    }
  };
  if (values["dry-run"]) {
    printCalls();
    if (target.refusal !== null) {
      console.log(`a release run refuses: ${target.refusal}`);
    }
    console.log("dry run: nothing built, uploaded or written");
    return;
  }
  const env = signingEnv(values.keys);

  const release: Release = {
    version,
    override: (config) => {
      const over = {
        ...(channel === "nightly" ? { version } : {}),
        ...target.configOverride(config),
      };
      return Object.keys(over).length === 0 ? [] : ["--config", JSON.stringify(over)];
    },
  };
  const targetDir = cargoTargetDir();
  mkdirSync(staging, { recursive: true });
  const built: AppBuilt[] = configs.map((config) => ({
    app: config.app,
    feedFile: config.feed.file,
    installers: BUILDS.flatMap((build) => runBuild(config, build, release, env, targetDir, staging)),
  }));

  const date = new Date();
  const read = plan.write(date, built);
  if (keep !== undefined) {
    printCalls();
    console.log(`not published: the installers, their signatures and what is published with them stand in ${keep}`);
    return;
  }
  const installers = new Map(everyInstaller(built).map((installer) => [installer.file, installer]));
  for (const call of plan.calls) {
    console.log(call.line);
    await call.run(installers);
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

/** The versions published where a release goes: its stable channel's newest and its nightly channel's. */
interface Published {
  readonly stable: string | null;
  readonly nightly: string | null;
}

/** One call a release's publication makes, as its line names it and as it is made. */
interface PublishCall {
  /** How it is made: a `gh` command run, or a call of the update server. */
  readonly verb: "run" | "call";
  /** The call as a line names it. */
  readonly line: string;
  run(installers: ReadonlyMap<string, BuiltInstaller>): Promise<void>;
}

/** What a release does once its version is known: the lines it prints, the calls it makes and what it writes. */
interface Plan {
  readonly lines: readonly string[];
  readonly calls: readonly PublishCall[];
  /** Writes into the staging folder what is published beside the installers, and returns the read naming them. */
  write(date: Date, built: readonly AppBuilt[]): ReleaseRead;
}

/** Where a release goes: GitHub for an official one, the test update server for a test one (docs/desktop.md,
 * 「Releases」). */
interface Target {
  readonly kind: "official" | "test";
  readonly destination: string;
  readonly published: Published;
  /** Why a release run would not publish, or null where it would; a dry run and a build kept unpublished go on. */
  readonly refusal: string | null;
  /** The stable endpoint an app of this release is built with. */
  endpoint(config: AppConfig): string;
  /** What is laid over an app's configuration besides a nightly's version. */
  configOverride(config: AppConfig): Record<string, unknown>;
  plan(version: string, files: readonly string[], staging: string): Plan;
}

/** An official release: built with the configuration's own GitHub feed and published as a GitHub release. */
function officialTarget(repository: Repository, configs: readonly AppConfig[], channel: Channel, commit: string): Target {
  const isPublic = repositoryIsPublic(repository);
  const published = publishedRead(repository);
  const assetsNow = channel === "nightly" ? nightlyAssets(repository) : null;
  return {
    kind: "official",
    destination: `GitHub ${repository.slug}`,
    published: { stable: published?.version ?? null, nightly: published?.nightly?.version ?? null },
    refusal: isPublic
      ? null
      : `${repository.slug} is private, and GitHub answers a private repository's releases to its members alone; ` +
        "official releases are published once it is public, at the set's 1.0.0, and a test release (--test) goes to the test update server meanwhile",
    endpoint: (config) => latestAssetUrl(repository, config.feed.file).href,
    configOverride: () => ({}),
    plan: (version, files, staging) => {
      const tag = channelTag(channel, version);
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
      const lines = [
        isPublic ? `GitHub         ${repository.slug}, tag ${tag}` : `GitHub         ${repository.slug} is private, tag ${tag}`,
        ...configs.map((config) => {
          const feedUrl =
            channel === "stable" ? latestAssetUrl(repository, config.feed.file) : new URL(config.feed.file, assetBaseUrl(repository, tag));
          return `updater feed   ${feedUrl.href} (${config.app.name})`;
        }),
        `release read   ${latestAssetUrl(repository, "release.json").href}`,
        ...files.map((file) => `installer      ${new URL(encodeURIComponent(file), assetBaseUrl(repository, tag)).href}`),
      ];
      return {
        lines,
        calls: githubCalls(publication).map((call) => ({ verb: "run", line: shown(call), run: async () => runGh(call) })),
        write: (date, built) => {
          const { release: read, feeds } = releaseReads(version, date, assetBaseUrl(repository, tag), built);
          writeFileSync(publication.ownRead, json(read));
          for (const { file, feed } of feeds) {
            writeFileSync(join(staging, file), json(feed));
          }
          mkdirSync(dirname(publication.consoleRead), { recursive: true });
          writeFileSync(publication.consoleRead, json(withChannelRelease(published, channel, read)));
          return read;
        },
      };
    },
  };
}

/** A test release: built to ask the test update server, and published there alone. */
async function testTarget(server: UpdateServer, configs: readonly AppConfig[], channel: Channel, commit: string): Promise<Target> {
  const remote = configs[0]?.app.product ?? "";
  const published = {
    stable: await newestOnServer(server, remote, "stable"),
    nightly: await newestOnServer(server, remote, "nightly"),
  };
  return {
    kind: "test",
    destination: `the update server ${server.address.href}`,
    published,
    refusal: null,
    endpoint: (config) => updateEndpoint(server, config.app),
    configOverride: (config) => ({ plugins: { updater: { endpoints: [updateEndpoint(server, config.app)] } } }),
    plan: (version) => {
      const updateApps: UpdateApp[] = configs.map((config) => ({
        app: config.app,
        title: config.product,
        files: BUILDS.flatMap((build) => build.formats.map((kind) => assetName(kind.fileName(config.product, version)))),
      }));
      return {
        lines: [`download read  ${new URL(`products/${remote}/download`, server.address).href}`],
        calls: updateServerCalls(channel, version, commit, updateApps).map((call) => ({
          verb: "call",
          line: shownCall(call),
          run: (installers) => callUpdateServer(server, call, installers),
        })),
        write: (date, built) => releaseReadOnServer(server, version, date, built),
      };
    },
  };
}

/** Runs one `gh` call of a publication, stopping the release where it fails. */
function runGh(call: GhCall): void {
  const result = spawnSync("gh", call, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`gh failed (exit ${result.status ?? "signal"}); the release stands as far as the calls above it went`);
  }
}

/** The read of a test release, its installers named at the update server's addresses of their bytes. */
function releaseReadOnServer(server: UpdateServer, version: string, date: Date, built: readonly AppBuilt[]): ReleaseRead {
  const read: ReleaseRead = { version, date: date.toISOString(), files: [] };
  for (const { app, installers } of built) {
    const base = new URL(`products/${encodeURIComponent(app.product)}/releases/${encodeURIComponent(version)}/files/`, server.address);
    app.place(
      read,
      installers.map(({ kind, file, size, sha256 }) => ({
        platform: kind.platform,
        arch: kind.arch,
        format: kind.format,
        file,
        size,
        sha256,
        url: new URL(`${encodeURIComponent(file)}/content`, base).href,
      })),
    );
  }
  return read;
}

/** The version a channel's release takes, refused where the updater would not take it over what is published where
 * the release goes. */
function channelVersion(channel: Channel, configured: string, published: Published, mirrored: readonly string[]): string {
  if (channel === "stable") {
    assertNewerVersion(configured, published.stable);
    return configured;
  }
  const taken = [...(published.nightly === null ? [] : [published.nightly]), ...mirrored];
  const version = nightlyVersion(configured, dayOf(new Date(), PLATFORM_TIME_ZONE), taken);
  assertNightlyVersion(version, published.stable, published.nightly);
  return version;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
