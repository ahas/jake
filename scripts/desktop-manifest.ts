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

/** The release folder's address: the folder holding the updater's endpoint, which must be its feed. */
export function releaseBaseUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!url.pathname.endsWith("/latest.json")) {
    throw new Error(`the updater endpoint ${endpoint} is not a latest.json feed`);
  }
  return new URL(".", url);
}

/** A channel's folder under the release folder: the folder itself for stable, its `nightly/` for nightly. */
export function channelBaseUrl(base: URL, channel: Channel): URL {
  return channel === "stable" ? base : new URL("nightly/", base);
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

/** The two reads of one release: the console's and the updater's, both naming the version's folder. */
export function releaseReads(
  version: string,
  date: Date,
  base: URL,
  installers: readonly Installer[],
): { release: ReleaseRead; feed: UpdaterFeed } {
  const versionDir = new URL(`${encodeURIComponent(version)}/`, base);
  const urlOf = (file: string): string => new URL(encodeURIComponent(file), versionDir).href;
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
