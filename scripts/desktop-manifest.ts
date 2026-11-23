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

/** The console's read of one release. */
export interface ReleaseRead {
  version: string;
  date: string;
  files: ReleaseFile[];
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

/**
 * The repository the updater's endpoint names: the stable feed is the latest release's `latest.json`,
 * `https://github.com/<owner>/<repository>/releases/latest/download/latest.json`, so no address is stated twice.
 */
export function repositoryOf(endpoint: string): Repository {
  const url = new URL(endpoint);
  const match = /^\/([^/]+)\/([^/]+)\/releases\/latest\/download\/latest\.json$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || match === null) {
    throw new Error(`the updater endpoint ${endpoint} is not a GitHub repository's latest release feed`);
  }
  return { slug: `${match[1]}/${match[2]}` };
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
export function assertNightlyVersion(version: string, published: ConsoleRead | null): void {
  if (published === null) {
    throw new Error("no stable release is published yet; a nightly follows a release");
  }
  assertNewerVersion(version, published.nightly?.version ?? null);
  assertNewerVersion(version, published.version);
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

/** The two reads of one release: the console's and the updater's, both naming each installer under `assetBase`. */
export function releaseReads(
  version: string,
  date: Date,
  assetBase: URL,
  installers: readonly Installer[],
): { release: ReleaseRead; feed: UpdaterFeed } {
  const urlOf = (file: string): string => new URL(encodeURIComponent(file), assetBase).href;
  const stamp = date.toISOString();

  const files = installers.map(({ kind, file, size, sha256 }) => ({
    platform: kind.platform,
    arch: kind.arch,
    format: kind.format,
    file,
    size,
    sha256,
    url: urlOf(file),
  }));

  const platforms: UpdaterFeed["platforms"] = {};
  for (const { kind, file, signature } of installers) {
    for (const key of kind.feedKeys) {
      if (key in platforms) {
        throw new Error(`two installers answer the feed key ${key}`);
      }
      platforms[key] = { signature, url: urlOf(file) };
    }
  }

  return { release: { version, date: stamp, files }, feed: { version, pub_date: stamp, platforms } };
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
  /** The channel's updater feed, `latest.json`. */
  readonly feed: string;
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
 * holding its installers, its feed and the console's read, and then published as the latest at once, so its feed
 * never names a file that is not yet there. A nightly replaces the assets of the one pre-release: the installers and the read first, the feed after
 * them, and the files the feed no longer names last; the latest stable release's console read is then replaced.
 */
export function githubCalls(publication: GitHubPublication): GhCall[] {
  const { repository, channel, version, commit, feed, consoleRead } = publication;
  const repo = ["--repo", repository.slug];
  const notes = ["--notes", `BMO desktop app ${version}, built from ${commit}.`];
  if (channel === "stable") {
    const tag = stableTag(version);
    return [
      ["release", "create", tag, ...repo, "--target", commit, "--title", `BMO desktop ${version}`, ...notes, "--draft", ...publication.assets, feed, consoleRead],
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
      ? [["release", "create", NIGHTLY_TAG, ...repo, "--target", commit, "--prerelease", ...title, ...notes, ...assets, feed]]
      : [
          ["release", "upload", NIGHTLY_TAG, ...repo, "--clobber", ...assets],
          ["release", "upload", NIGHTLY_TAG, ...repo, "--clobber", feed],
          ...publication.nightlyAssets
            .filter((name) => ![...assets, feed].map(baseName).includes(name))
            .map((name): GhCall => ["release", "delete-asset", NIGHTLY_TAG, name, ...repo, "--yes"]),
          ["release", "edit", NIGHTLY_TAG, ...repo, "--prerelease", ...title, ...notes],
        ];
  return [...calls, ["release", "upload", stableTag(publication.stableVersion), ...repo, "--clobber", consoleRead]];
}
