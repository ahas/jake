// The desktop app's release: its installers' formats and the two reads published for each version.

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

/** Refuses a version the updater would not take over the one already published. */
export function assertNewerVersion(version: string, published: string | null): void {
  if (published !== null && Bun.semver.order(version, published) <= 0) {
    throw new Error(`version ${version} is not higher than the published ${published}; raise the version first`);
  }
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
