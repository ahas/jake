// The desktop app's release: its channels, its installers' formats and the reads published for each version.

/** The channels a release goes out on (docs/desktop.md, 「Releases」): the set's releases, or the day's build. */
export const CHANNELS = ["stable", "nightly"] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

/** The platform's time zone, the one a nightly's day is read in. */
export const PLATFORM_TIME_ZONE = "Asia/Seoul";

/** How many nightlies the release folder keeps; a feed only ever names the newest. */
export const NIGHTLIES_KEPT = 7;

const NIGHTLY = /-nightly\.\d{8}(\.\d+)?$/;

/** One installer format the release ships, answering for its own name and its updater feed keys. */
export interface InstallerFormat {
  /** The format's name, as the console reads it and as `cargo tauri build --bundles` takes it. */
  readonly format: "nsis" | "appimage" | "deb";
  readonly platform: "windows" | "linux";
  readonly arch: "x86_64";
  /** The bundle folder Tauri writes this format into, under the build's `bundle` folder. */
  readonly bundleDir: string;
  /** The keys of the updater feed this installer answers, most specific first. */
  readonly feedKeys: readonly string[];
  /** The file name Tauri gives this format's installer. */
  fileName(product: string, version: string): string;
}

export const NSIS: InstallerFormat = {
  format: "nsis",
  platform: "windows",
  arch: "x86_64",
  bundleDir: "nsis",
  feedKeys: ["windows-x86_64-nsis", "windows-x86_64"],
  fileName: (product, version) => `${product}_${version}_x64-setup.exe`,
};

export const APPIMAGE: InstallerFormat = {
  format: "appimage",
  platform: "linux",
  arch: "x86_64",
  bundleDir: "appimage",
  feedKeys: ["linux-x86_64-appimage", "linux-x86_64"],
  fileName: (product, version) => `${product}_${version}_amd64.AppImage`,
};

export const DEB: InstallerFormat = {
  format: "deb",
  platform: "linux",
  arch: "x86_64",
  bundleDir: "deb",
  feedKeys: ["linux-x86_64-deb"],
  fileName: (product, version) => `${product}_${version}_amd64.deb`,
};

/** One built installer, measured and signed. */
export interface Installer {
  readonly kind: InstallerFormat;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  /** The updater signature, the text of the `.sig` file Tauri writes beside the installer. */
  readonly signature: string;
}

/** One entry of the console's read (docs/desktop.md, 「The read the console uses」). */
export interface ReleaseFile {
  platform: InstallerFormat["platform"];
  arch: InstallerFormat["arch"];
  format: InstallerFormat["format"];
  file: string;
  size: number;
  sha256: string;
  url: string;
}

/** The console's read of one release: the remote controller's installers under `files`, the all-in-one's under
 * `allInOne`, which a reader of the remote controller alone passes over. */
export interface ReleaseRead {
  version: string;
  date: string;
  files: ReleaseFile[];
  allInOne?: { files: ReleaseFile[] };
}

/** One of the desktop apps a release carries, every one built from the same commit at the same version
 * (docs/desktop.md, 「Releases」; docs/all-in-one.md, 「Updates」). */
export interface DesktopApp {
  /** How the release's lines name it. */
  readonly name: string;
  /** Its product on the update server (bmo-update's docs/design.md). */
  readonly product: string;
  /** The key the remote controller's download read names it under as a companion, or null for none. */
  readonly companionKey: string | null;
  /** The Tauri configuration laid over the crate's own, a file of the `desktop` folder, or null for none. */
  readonly overlay: string | null;
  /** The crate's features it is built with. */
  readonly features: readonly string[];
  /** Its installers' entries put into the console's read of one release. */
  place(read: ReleaseRead, files: ReleaseFile[]): void;
}

export const REMOTE_CONTROLLER: DesktopApp = {
  name: "remote controller",
  product: "bmo-desktop",
  companionKey: null,
  overlay: null,
  features: [],
  place: (read, files) => {
    read.files = files;
  },
};

export const ALL_IN_ONE: DesktopApp = {
  name: "all-in-one",
  product: "bmo-all-in-one",
  companionKey: "allInOne",
  overlay: "tauri.all-in-one.conf.json",
  features: ["all-in-one"],
  place: (read, files) => {
    read.allInOne = { files };
  },
};

/** Every app a release builds, the remote controller first. */
export const APPS: readonly DesktopApp[] = [REMOTE_CONTROLLER, ALL_IN_ONE];

/**
 * The name an installer is published under: Tauri names it after the product, and GitHub rewrites the spaces of
 * an asset's name, so a product's spaces are dashes in what is uploaded and in every read that names it.
 */
export function assetName(built: string): string {
  return built.replaceAll(" ", "-");
}

/** The console's read of the release folder: the stable release at its top level, and the newest nightly. */
export interface ConsoleRead extends ReleaseRead {
  nightly?: ReleaseRead;
}

/** The updater's feed, in the form Tauri's updater reads. */
export interface UpdaterFeed {
  version: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/** The tag of the one pre-release whose assets each nightly replaces. */
export const NIGHTLY_TAG = "desktop-nightly";

/** The tag of a stable version's own release. */
export function stableTag(version: string): string {
  return `desktop-v${version}`;
}

/** A channel's tag: the version's own for stable, the one nightly pre-release's for nightly. */
export function channelTag(channel: Channel, version: string): string {
  return channel === "stable" ? stableTag(version) : NIGHTLY_TAG;
}

/** The public repository the releases are published in, as `<owner>/<repository>`. */
export interface Repository {
  readonly slug: string;
}

/** A feed the updater reads: the repository whose releases carry it, and its file's name. */
export interface Feed {
  readonly repository: Repository;
  readonly file: string;
}

/**
 * The feed an app's updater endpoint names: the stable feed is an asset of the latest release,
 * `https://github.com/<owner>/<repository>/releases/latest/download/<file>`, the file `latest.json` or
 * `<app>-latest.json`, so no address is stated twice.
 */
export function feedOf(endpoint: string): Feed {
  const url = new URL(endpoint);
  const match = /^\/([^/]+)\/([^/]+)\/releases\/latest\/download\/((?:[a-z0-9-]+-)?latest\.json)$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || match === null) {
    throw new Error(`the updater endpoint ${endpoint} is not a GitHub repository's latest release feed`);
  }
  return { repository: { slug: `${match[1]}/${match[2]}` }, file: match[3] ?? "latest.json" };
}

/** The repository every app's feed names; apps whose feeds name different repositories, or one file, are refused. */
export function repositoryOf(feeds: readonly Feed[]): Repository {
  const slugs = new Set(feeds.map((feed) => feed.repository.slug));
  const [slug] = slugs;
  if (slug === undefined || slugs.size !== 1) {
    throw new Error(`the apps' updater feeds name ${slugs.size === 0 ? "no repository" : "different repositories"}`);
  }
  if (new Set(feeds.map((feed) => feed.file)).size !== feeds.length) {
    throw new Error("two apps' updater feeds name one file");
  }
  return { slug };
}

/** The address a release's assets download from: the folder of its tag's assets. */
export function assetBaseUrl(repository: Repository, tag: string): URL {
  return new URL(`https://github.com/${repository.slug}/releases/download/${encodeURIComponent(tag)}/`);
}

/** The address an asset of the latest stable release always downloads from, whichever version is latest. */
export function latestAssetUrl(repository: Repository, file: string): URL {
  return new URL(`https://github.com/${repository.slug}/releases/latest/download/${encodeURIComponent(file)}`);
}

/** A channel's folder in a mirror folder: the folder itself for stable, its `nightly/` for nightly. */
export function channelBaseUrl(base: URL, channel: Channel): URL {
  return channel === "stable" ? base : new URL("nightly/", base);
}

/** A version's folder in a mirror's channel folder. */
export function versionBaseUrl(channelBase: URL, version: string): URL {
  return new URL(`${encodeURIComponent(version)}/`, channelBase);
}

/** Refuses a version the updater would not take over the one already published. */
export function assertNewerVersion(version: string, published: string | null): void {
  if (published !== null && Bun.semver.order(version, published) <= 0) {
    throw new Error(`version ${version} is not higher than the published ${published}; raise the version first`);
  }
}

/** The day a moment falls on in a time zone, as YYYYMMDD. */
export function dayOf(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((one) => one.type === type)?.value ?? "";

  return `${part("year")}${part("month")}${part("day")}`;
}

/**
 * The nightly's version (bmo-chat's docs/conventions.md, 「Versions」): the minor above the release, then the day,
 * and `.<n>` counting from 2 above the nightlies of that day already taken.
 */
export function nightlyVersion(release: string, day: string, taken: Iterable<string>): string {
  const core = /^(\d+)\.(\d+)\.(\d+)$/.exec(release);
  if (core === null) {
    throw new Error(`the release version ${release} is not a bare major.minor.patch`);
  }
  if (!/^\d{8}$/.test(day)) {
    throw new Error(`the day ${day} is not YYYYMMDD`);
  }
  const base = `${core[1]}.${Number(core[2]) + 1}.0-nightly.${day}`;
  let count = 0;
  for (const version of taken) {
    if (version === base) {
      count = Math.max(count, 1);
    } else if (version.startsWith(`${base}.`)) {
      const n = Number(version.slice(base.length + 1));
      if (Number.isSafeInteger(n) && n > 0) {
        count = Math.max(count, n);
      }
    }
  }
  return count === 0 ? base : `${base}.${count + 1}`;
}

/** Refuses a nightly before the first release, and one the updater would not take over either published channel. */
export function assertNightlyVersion(version: string, stable: string | null, nightly: string | null): void {
  if (stable === null) {
    throw new Error("no stable release is published yet; a nightly follows a release");
  }
  assertNewerVersion(version, nightly);
  assertNewerVersion(version, stable);
}

/** The console's read with one channel's release put in, the other channel's kept as it stood. */
export function withChannelRelease(published: ConsoleRead | null, channel: Channel, release: ReleaseRead): ConsoleRead {
  if (channel === "nightly") {
    if (published === null) {
      throw new Error("no stable release is published yet; a nightly follows a release");
    }
    return { ...published, nightly: release };
  }
  return published?.nightly === undefined ? release : { ...release, nightly: published.nightly };
}

/** The nightly folders past the newest ones kept, oldest last; a folder that names no nightly is never among them. */
export function nightliesPastKept(folders: readonly string[], kept: number = NIGHTLIES_KEPT): string[] {
  return folders
    .filter((folder) => NIGHTLY.test(folder))
    .sort((a, b) => Bun.semver.order(b, a))
    .slice(kept);
}

/** One app's installers in a release, with the file its feed is published as. */
export interface AppInstallers {
  readonly app: DesktopApp;
  readonly feedFile: string;
  readonly installers: readonly Installer[];
}

/** The reads of one release: the console's, naming every app's installers, and each app's updater feed, every one
 * naming its installers under `assetBase`. */
export function releaseReads(
  version: string,
  date: Date,
  assetBase: URL,
  apps: readonly AppInstallers[],
): { release: ReleaseRead; feeds: { file: string; feed: UpdaterFeed }[] } {
  const urlOf = (file: string): string => new URL(encodeURIComponent(file), assetBase).href;
  const stamp = date.toISOString();
  const release: ReleaseRead = { version, date: stamp, files: [] };
  const feeds = apps.map(({ app, feedFile, installers }) => {
    app.place(
      release,
      installers.map(({ kind, file, size, sha256 }) => ({
        platform: kind.platform,
        arch: kind.arch,
        format: kind.format,
        file,
        size,
        sha256,
        url: urlOf(file),
      })),
    );
    const platforms: UpdaterFeed["platforms"] = {};
    for (const { kind, file, signature } of installers) {
      for (const key of kind.feedKeys) {
        if (key in platforms) {
          throw new Error(`two installers of the ${app.name} answer the feed key ${key}`);
        }
        platforms[key] = { signature, url: urlOf(file) };
      }
    }
    return { file: feedFile, feed: { version, pub_date: stamp, platforms } };
  });
  return { release, feeds };
}

/** One `gh` call of a publication, its arguments after `gh`. */
export type GhCall = readonly string[];

/** What a GitHub publication puts where, its files named as they are uploaded. */
export interface GitHubPublication {
  readonly repository: Repository;
  readonly channel: Channel;
  readonly version: string;
  /** The commit the release is made from, which a new tag points at. */
  readonly commit: string;
  /** The installers and their signatures. */
  readonly assets: readonly string[];
  /** The version's own read, `release.json`, which the nightly pre-release carries for its nightly. */
  readonly ownRead: string;
  /** The channel's updater feeds, every app's: `latest.json` and `all-in-one-latest.json`. */
  readonly feeds: readonly string[];
  /** The console's read of both channels, `release.json`, which the latest stable release carries. */
  readonly consoleRead: string;
  /** For a nightly, the latest stable version, whose release carries the console's read. */
  readonly stableVersion: string | null;
  /** For a nightly, the names of the assets the nightly pre-release holds now, or null where it does not stand yet. */
  readonly nightlyAssets: readonly string[] | null;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * The `gh` calls that publish a release (docs/desktop.md, 「Making a release」). A stable release is made a draft
 * holding its installers, its feeds and the console's read, and then published as the latest at once, so a feed
 * never names a file that is not yet there. A nightly replaces the assets of the one pre-release: the installers and
 * the read first, the feeds after them, and the files no feed names any more last; the latest stable release's
 * console read is then replaced.
 */
export function githubCalls(publication: GitHubPublication): GhCall[] {
  const { repository, channel, version, commit, feeds, consoleRead } = publication;
  const repo = ["--repo", repository.slug];
  const notes = ["--notes", `BMO desktop app ${version}, built from ${commit}.`];
  if (channel === "stable") {
    const tag = stableTag(version);
    return [
      ["release", "create", tag, ...repo, "--target", commit, "--title", `BMO desktop ${version}`, ...notes, "--draft", ...publication.assets, ...feeds, consoleRead],
      ["release", "edit", tag, ...repo, "--draft=false", "--latest"],
    ];
  }
  if (publication.stableVersion === null) {
    throw new Error("no stable release is published yet; a nightly follows a release");
  }
  const title = ["--title", `BMO desktop nightly ${version}`];
  const assets = [...publication.assets, publication.ownRead];
  const calls: GhCall[] =
    publication.nightlyAssets === null
      ? [["release", "create", NIGHTLY_TAG, ...repo, "--target", commit, "--prerelease", ...title, ...notes, ...assets, ...feeds]]
      : [
          ["release", "upload", NIGHTLY_TAG, ...repo, "--clobber", ...assets],
          ["release", "upload", NIGHTLY_TAG, ...repo, "--clobber", ...feeds],
          ...publication.nightlyAssets
            .filter((name) => ![...assets, ...feeds].map(baseName).includes(name))
            .map((name): GhCall => ["release", "delete-asset", NIGHTLY_TAG, name, ...repo, "--yes"]),
          ["release", "edit", NIGHTLY_TAG, ...repo, "--prerelease", ...title, ...notes],
        ];
  return [...calls, ["release", "upload", stableTag(publication.stableVersion), ...repo, "--clobber", consoleRead]];
}

/** The update server a test release publishes to, as the publisher's file names it (docs/desktop.md, 「Making a release」). */
export interface UpdateServer {
  /** The public address every app is built to ask, with its closing slash. */
  readonly address: URL;
  /** The address the release reads and publishes at, with its closing slash. */
  readonly publishAddress: URL;
  /** The publishing token. */
  readonly token: string;
}

const withSlash = (address: string): URL => new URL(address.endsWith("/") ? address : `${address}/`);

/**
 * The update server the publisher's file names: `BMO_UPDATE_ADDRESS`, `BMO_UPDATE_PUBLISH_ADDRESS` and
 * `BMO_UPDATE_TOKEN`, each line read by its key before its first `=` and its value verbatim after it. A missing
 * line, or a public address that is not HTTPS, is refused, naming the key and never a value.
 */
export function updateServerOf(text: string, file: string): UpdateServer {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) {
      values.set(line.slice(0, at).trim(), line.slice(at + 1));
    }
  }
  const value = (key: string): string => {
    const found = values.get(key);
    if (found === undefined || found === "") {
      throw new Error(`the publisher's file ${file} holds no ${key}`);
    }
    return found;
  };
  const address = withSlash(value("BMO_UPDATE_ADDRESS"));
  if (address.protocol !== "https:") {
    throw new Error(`the publisher's file ${file} names a BMO_UPDATE_ADDRESS that is not HTTPS, which a release build's updater refuses`);
  }
  return { address, publishAddress: withSlash(value("BMO_UPDATE_PUBLISH_ADDRESS")), token: value("BMO_UPDATE_TOKEN") };
}

/** The channels every app's product declares: stable, and nightly offering stable's releases as well. */
export const PRODUCT_CHANNELS = [
  { name: "stable", includes: [] },
  { name: "nightly", includes: ["stable"] },
] as const;

/** The stable endpoint a test app is built to ask on the update server; the app works out the nightly one from it. */
export function updateEndpoint(server: UpdateServer, app: DesktopApp): string {
  return `${server.address.href}updates/${app.product}/stable/{{target}}/{{arch}}/{{current_version}}?bundleType={{bundle_type}}`;
}

/** One call of the update server's publication: a JSON body, an installer's bytes, or none. */
export interface UpdateCall {
  readonly method: "PUT" | "PATCH";
  /** The path under the publishing address. */
  readonly path: string;
  readonly json?: unknown;
  /** The installer whose declaration or bytes the call carries, by its published name. */
  readonly installer?: { readonly file: string; readonly part: "declaration" | "content" };
}

/** One app of a release as the update server is told of it: its title and its installers' published names, in order. */
export interface UpdateApp {
  readonly app: DesktopApp;
  readonly title: string;
  readonly files: readonly string[];
}

const segment = (text: string): string => encodeURIComponent(text);

/**
 * The calls that publish a release to the update server: both products declared, the remote controller naming every
 * other app its companion; each app's release made a draft with its installers declared and uploaded, in the order
 * they are built; then each put live, the companions before the remote controller, so its download read names them.
 */
export function updateServerCalls(channel: Channel, version: string, commit: string, apps: readonly UpdateApp[]): UpdateCall[] {
  const companions = Object.fromEntries(
    apps.flatMap(({ app }) => (app.companionKey === null ? [] : [[app.companionKey, app.product]])),
  );
  const releasePath = (app: DesktopApp): string => `products/${segment(app.product)}/releases/${segment(version)}`;
  const declarations: UpdateCall[] = apps.map(({ app, title }) => ({
    method: "PUT",
    path: `products/${segment(app.product)}`,
    json: { title, channels: PRODUCT_CHANNELS, companions: app.companionKey === null ? companions : {} },
  }));
  const drafts: UpdateCall[] = apps.flatMap(({ app, files }) => [
    {
      method: "PUT",
      path: releasePath(app),
      json: { channel, notes: `BMO desktop app ${version}, built from ${commit}.`, commit },
    } satisfies UpdateCall,
    ...files.flatMap((file): UpdateCall[] => [
      { method: "PUT", path: `${releasePath(app)}/files/${segment(file)}`, installer: { file, part: "declaration" } },
      { method: "PUT", path: `${releasePath(app)}/files/${segment(file)}/content`, installer: { file, part: "content" } },
    ]),
  ]);
  const live: UpdateCall[] = [...apps]
    .sort((a, b) => Number(a.app.companionKey === null) - Number(b.app.companionKey === null))
    .map(({ app }) => ({ method: "PATCH", path: releasePath(app), json: { state: "live" } }));
  return [...declarations, ...drafts, ...live];
}

/** A call of the update server as a line names it. */
export function shownCall(call: UpdateCall): string {
  const part = call.installer === undefined ? "" : call.installer.part === "content" ? " <installer bytes>" : " <installer declaration>";
  return `${call.method} ${call.path}${call.json === undefined ? part : ` ${JSON.stringify(call.json)}`}`;
}
