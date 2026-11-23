import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APPIMAGE,
  DEB,
  NSIS,
  type ConsoleRead,
  type Installer,
  type ReleaseRead,
  type GitHubPublication,
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
  versionBaseUrl,
  withChannelRelease,
} from "../scripts/desktop-manifest";

// A mirror folder's served address, as the owner's server serves it.
const base = new URL("https://mirror.example/bmo/jake/desktop/");
const repository = repositoryOf("https://github.com/ahas/jake/releases/latest/download/latest.json");
const date = new Date("2026-11-16T12:00:00Z");
const installers: Installer[] = [NSIS, APPIMAGE, DEB].map((kind, i) => ({
  kind,
  file: kind.fileName("BMO", "0.2.0"),
  size: 1000 + i,
  sha256: `${i}`.repeat(64),
  signature: `sig-${kind.format}`,
}));

describe("repositoryOf", () => {
  test("is the repository whose latest release's feed the updater reads", () => {
    expect(repository.slug).toBe("ahas/jake");
  });

  test("refuses an endpoint that is not a GitHub latest release's feed", () => {
    for (const endpoint of [
      "https://mirror.example/bmo/jake/desktop/latest.json",
      "https://github.com/ahas/jake/releases/download/desktop-v1.0.0/latest.json",
      "https://github.com/ahas/jake/releases/latest/download/feed.json",
      "https://example.com/ahas/jake/releases/latest/download/latest.json",
    ]) {
      expect(() => repositoryOf(endpoint)).toThrow("latest release feed");
    }
  });
});

describe("GitHub addresses", () => {
  test("a stable version has a tag of its own and the nightly one tag for all", () => {
    expect(channelTag("stable", "1.0.0")).toBe("desktop-v1.0.0");
    expect(channelTag("nightly", "1.1.0-nightly.20261124")).toBe("desktop-nightly");
  });

  test("a release's assets download from its tag, and the latest stable's from one address", () => {
    expect(assetBaseUrl(repository, "desktop-v1.0.0").href).toBe("https://github.com/ahas/jake/releases/download/desktop-v1.0.0/");
    expect(latestAssetUrl(repository, "release.json").href).toBe("https://github.com/ahas/jake/releases/latest/download/release.json");
  });

  test("the reads name the release's assets", () => {
    const { release, feed } = releaseReads("1.0.0", date, assetBaseUrl(repository, "desktop-v1.0.0"), installers);

    expect(release.files[0]?.url).toBe("https://github.com/ahas/jake/releases/download/desktop-v1.0.0/BMO_0.2.0_x64-setup.exe");
    expect(feed.platforms["linux-x86_64-deb"]?.url).toBe("https://github.com/ahas/jake/releases/download/desktop-v1.0.0/BMO_0.2.0_amd64.deb");
  });
});

describe("githubCalls", () => {
  const publication: GitHubPublication = {
    repository,
    channel: "stable",
    version: "1.0.0",
    commit: "abc123",
    assets: ["s/BMO_1.0.0_x64-setup.exe", "s/BMO_1.0.0_x64-setup.exe.sig"],
    ownRead: "s/release.json",
    feed: "s/latest.json",
    consoleRead: "s/console/release.json",
    stableVersion: null,
    nightlyAssets: null,
  };

  test("a stable release is drafted with its installers, feed and console read, then published as the latest", () => {
    expect(githubCalls(publication)).toEqual([
      [
        "release", "create", "desktop-v1.0.0", "--repo", "ahas/jake", "--target", "abc123", "--title", "BMO desktop 1.0.0",
        "--notes", "BMO desktop app 1.0.0, built from abc123.", "--draft",
        "s/BMO_1.0.0_x64-setup.exe", "s/BMO_1.0.0_x64-setup.exe.sig", "s/latest.json", "s/console/release.json",
      ],
      ["release", "edit", "desktop-v1.0.0", "--repo", "ahas/jake", "--draft=false", "--latest"],
    ]);
  });

  test("the first nightly makes the pre-release, then puts the console read on the latest stable release", () => {
    const calls = githubCalls({ ...publication, channel: "nightly", version: "1.1.0-nightly.20261124", stableVersion: "1.0.0" });

    expect(calls[0]?.slice(0, 7)).toEqual(["release", "create", "desktop-nightly", "--repo", "ahas/jake", "--target", "abc123"]);
    expect(calls[0]).toContain("--prerelease");
    expect(calls[0]?.slice(-4)).toEqual(["s/BMO_1.0.0_x64-setup.exe", "s/BMO_1.0.0_x64-setup.exe.sig", "s/release.json", "s/latest.json"]);
    expect(calls[1]).toEqual(["release", "upload", "desktop-v1.0.0", "--repo", "ahas/jake", "--clobber", "s/console/release.json"]);
    expect(calls).toHaveLength(2);
  });

  test("a later nightly replaces the assets, the feed after the installers and the old files last", () => {
    const calls = githubCalls({
      ...publication,
      channel: "nightly",
      version: "1.1.0-nightly.20261125",
      stableVersion: "1.0.0",
      nightlyAssets: ["BMO_1.1.0-nightly.20261124_x64-setup.exe", "release.json", "latest.json", "BMO_1.0.0_x64-setup.exe.sig"],
    });

    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
      "release upload desktop-nightly",
      "release upload desktop-nightly",
      "release delete-asset desktop-nightly",
      "release edit desktop-nightly",
      "release upload desktop-v1.0.0",
    ]);
    expect(calls[1]?.at(-1)).toBe("s/latest.json");
    expect(calls[2]?.[3]).toBe("BMO_1.1.0-nightly.20261124_x64-setup.exe");
  });

  test("refuses a nightly before the first release", () => {
    expect(() => githubCalls({ ...publication, channel: "nightly" })).toThrow("follows a release");
  });
});

describe("assertNewerVersion", () => {
  test("takes the first release and a higher version", () => {
    expect(() => assertNewerVersion("0.1.0", null)).not.toThrow();
    expect(() => assertNewerVersion("0.10.0", "0.9.0")).not.toThrow();
  });

  test("refuses the published version and a lower one", () => {
    expect(() => assertNewerVersion("0.2.0", "0.2.0")).toThrow("not higher");
    expect(() => assertNewerVersion("0.1.9", "0.2.0")).toThrow("not higher");
  });
});

describe("releaseReads", () => {
  const { release, feed } = releaseReads("0.2.0", date, versionBaseUrl(base, "0.2.0"), installers);

  test("the console's read names each installer in the version's folder", () => {
    expect(release).toEqual({
      version: "0.2.0",
      date: "2026-11-16T12:00:00.000Z",
      files: [
        {
          platform: "windows",
          arch: "x86_64",
          format: "nsis",
          file: "BMO_0.2.0_x64-setup.exe",
          size: 1000,
          sha256: "0".repeat(64),
          url: "https://mirror.example/bmo/jake/desktop/0.2.0/BMO_0.2.0_x64-setup.exe",
        },
        {
          platform: "linux",
          arch: "x86_64",
          format: "appimage",
          file: "BMO_0.2.0_amd64.AppImage",
          size: 1001,
          sha256: "1".repeat(64),
          url: "https://mirror.example/bmo/jake/desktop/0.2.0/BMO_0.2.0_amd64.AppImage",
        },
        {
          platform: "linux",
          arch: "x86_64",
          format: "deb",
          file: "BMO_0.2.0_amd64.deb",
          size: 1002,
          sha256: "2".repeat(64),
          url: "https://mirror.example/bmo/jake/desktop/0.2.0/BMO_0.2.0_amd64.deb",
        },
      ],
    });
  });

  test("the updater's feed gives each key its installer's signature, and the deb its own key", () => {
    const signatures = Object.fromEntries(Object.entries(feed.platforms).map(([key, entry]) => [key, entry.signature]));
    expect(signatures).toEqual({
      "windows-x86_64-nsis": "sig-nsis",
      "windows-x86_64": "sig-nsis",
      "linux-x86_64-appimage": "sig-appimage",
      "linux-x86_64": "sig-appimage",
      "linux-x86_64-deb": "sig-deb",
    });
    expect(feed.platforms["linux-x86_64-deb"]?.url).toBe(release.files[2]?.url);
    expect(feed.pub_date).toBe(release.date);
  });

  test("refuses two installers answering one feed key", () => {
    expect(() => releaseReads("0.2.0", date, versionBaseUrl(base, "0.2.0"), [installers[1]!, installers[1]!])).toThrow("two installers");
  });
});

describe("channels", () => {
  test("are stable and nightly alone", () => {
    expect(["stable", "nightly"].every(isChannel)).toBe(true);
    for (const other of ["beta", "Stable", "", undefined, null]) {
      expect(isChannel(other)).toBe(false);
    }
  });

  test("each has a folder of its own, the nightly's under the stable one", () => {
    expect(channelBaseUrl(base, "stable").href).toBe("https://mirror.example/bmo/jake/desktop/");
    expect(channelBaseUrl(base, "nightly").href).toBe("https://mirror.example/bmo/jake/desktop/nightly/");
  });

  test("a nightly's feed and read name its own folder", () => {
    const nightly = versionBaseUrl(channelBaseUrl(base, "nightly"), "1.1.0-nightly.20261124");
    const { release, feed } = releaseReads("1.1.0-nightly.20261124", date, nightly, installers);

    expect(release.files[0]?.url).toBe(
      "https://mirror.example/bmo/jake/desktop/nightly/1.1.0-nightly.20261124/BMO_0.2.0_x64-setup.exe",
    );
    expect(feed.platforms["windows-x86_64"]?.url).toBe(release.files[0]?.url);
  });
});

describe("dayOf", () => {
  test("reads the day in the time zone given, not the machine's", () => {
    const evening = new Date("2026-11-23T16:30:00Z");

    expect(dayOf(evening, "Asia/Seoul")).toBe("20261124");
    expect(dayOf(evening, "UTC")).toBe("20261123");
  });
});

describe("nightlyVersion", () => {
  test("is the minor above the release, then the day", () => {
    expect(nightlyVersion("1.0.0", "20261124", [])).toBe("1.1.0-nightly.20261124");
    expect(nightlyVersion("1.4.2", "20261124", [])).toBe("1.5.0-nightly.20261124");
    expect(nightlyVersion("0.2.1", "20261124", ["1.1.0-nightly.20261123"])).toBe("0.3.0-nightly.20261124");
  });

  test("counts a second nightly of the day from 2, above every one taken", () => {
    expect(nightlyVersion("1.0.0", "20261124", ["1.1.0-nightly.20261124"])).toBe("1.1.0-nightly.20261124.2");
    expect(nightlyVersion("1.0.0", "20261124", ["1.1.0-nightly.20261124.2", "1.1.0-nightly.20261124"])).toBe(
      "1.1.0-nightly.20261124.3",
    );
    expect(nightlyVersion("1.0.0", "20261124", ["1.1.0-nightly.20261123.4", "1.1.0-nightly.202611245"])).toBe(
      "1.1.0-nightly.20261124",
    );
  });

  test("orders after the release it follows and the nightly before it, and before the release it leads to", () => {
    const second = nightlyVersion("1.0.0", "20261124", ["1.1.0-nightly.20261124"]);

    expect(Bun.semver.order("1.1.0-nightly.20261124", "1.0.0")).toBe(1);
    expect(Bun.semver.order(second, "1.1.0-nightly.20261124")).toBe(1);
    expect(Bun.semver.order("1.1.0-nightly.20261125", second)).toBe(1);
    expect(Bun.semver.order("1.1.0", "1.1.0-nightly.20261125.9")).toBe(1);
  });

  test("refuses a release that is not a bare version and a day that is not YYYYMMDD", () => {
    expect(() => nightlyVersion("1.0.0-rev.3", "20261124", [])).toThrow("bare");
    expect(() => nightlyVersion("1.0.0", "2026-11-24", [])).toThrow("YYYYMMDD");
  });
});

describe("assertNightlyVersion", () => {
  const stable: ConsoleRead = { version: "1.0.0", date: "2026-11-23T00:00:00.000Z", files: [] };
  const nightly: ReleaseRead = { version: "1.1.0-nightly.20261124", date: "2026-11-24T00:00:00.000Z", files: [] };

  test("takes a nightly above both channels", () => {
    expect(() => assertNightlyVersion("1.1.0-nightly.20261125", { ...stable, nightly })).not.toThrow();
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", stable)).not.toThrow();
  });

  test("refuses one before the first release, not above the nightly, or behind the stable", () => {
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", null)).toThrow("follows a release");
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", { ...stable, nightly })).toThrow("not higher");
    expect(() => assertNightlyVersion("1.1.0-nightly.20261123", { ...stable, nightly })).toThrow("not higher");
    expect(() => assertNightlyVersion("1.0.0-nightly.20261126", stable)).toThrow("not higher");
  });
});

describe("withChannelRelease", () => {
  const stable: ReleaseRead = { version: "1.0.0", date: "2026-11-23T00:00:00.000Z", files: [] };
  const nightly: ReleaseRead = { version: "1.1.0-nightly.20261124", date: "2026-11-24T00:00:00.000Z", files: [] };

  test("a nightly goes under nightly and keeps the stable fields where they are", () => {
    expect(withChannelRelease(stable, "nightly", nightly)).toEqual({ ...stable, nightly });
  });

  test("a stable release replaces the top level and keeps the nightly", () => {
    const next: ReleaseRead = { ...stable, version: "1.1.0" };

    expect(withChannelRelease({ ...stable, nightly }, "stable", next)).toEqual({ ...next, nightly });
    expect(withChannelRelease(null, "stable", next)).toEqual(next);
    expect("nightly" in withChannelRelease(stable, "stable", next)).toBe(false);
  });

  test("refuses a nightly before the first release", () => {
    expect(() => withChannelRelease(null, "nightly", nightly)).toThrow("follows a release");
  });
});

describe("nightliesPastKept", () => {
  test("names the nightlies older than the newest kept, by semver, and nothing else", () => {
    const folders = [
      "1.1.0-nightly.20261120",
      "1.1.0-nightly.20261124.2",
      "1.1.0-nightly.20261124",
      "1.2.0-nightly.20261126",
      "1.1.0-nightly.20261121",
      "1.0.0",
      "latest.json",
    ];

    expect(nightliesPastKept(folders, 3)).toEqual(["1.1.0-nightly.20261121", "1.1.0-nightly.20261120"]);
    expect(nightliesPastKept(folders)).toEqual([]);
  });
});

describe("the release's GitHub dry run", () => {
  // A stand-in `gh` on the PATH: it answers the reads of the published releases from FAKE_GH_PUBLISHED (a stable
  // version, or nothing) and FAKE_GH_NIGHTLY (whether the nightly pre-release stands), logs every call it is given,
  // and refuses anything else, so a dry run that would write is seen.
  const root = mkdtempSync(join(tmpdir(), "jake-desktop-release-dry-"));
  const bin = join(root, "bin");
  const keys = join(root, "keys");
  const log = join(root, "gh.log");
  spawnSync("mkdir", ["-p", bin, keys]);
  writeFileSync(join(keys, "jake-desktop-updater.key"), "not a key");
  writeFileSync(join(keys, "jake-desktop-updater.password"), "not a password");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "release view --repo ahas/jake --json tagName")
    [ -z "$FAKE_GH_PUBLISHED" ] && { echo "release not found" >&2; exit 1; }
    echo "{\\"tagName\\":\\"desktop-v$FAKE_GH_PUBLISHED\\"}" ;;
  "release download desktop-v$FAKE_GH_PUBLISHED --repo ahas/jake --pattern release.json --output -")
    echo "{\\"version\\":\\"$FAKE_GH_PUBLISHED\\",\\"date\\":\\"2026-11-01T00:00:00.000Z\\",\\"files\\":[]}" ;;
  "release view desktop-nightly --repo ahas/jake --json assets")
    [ -z "$FAKE_GH_NIGHTLY" ] && { echo "release not found" >&2; exit 1; }
    echo '{"assets":[{"name":"latest.json"},{"name":"BMO_0.3.0-nightly.20261101_amd64.deb"}]}' ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  function dryRun(channel: string, published: string, nightly: boolean): { status: number | null; out: string; calls: string[] } {
    rmSync(log, { force: true });
    const result = spawnSync("bun", ["scripts/desktop-release.ts", "--channel", channel, "--keys", keys, "--dry-run"], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_PUBLISHED: published, FAKE_GH_NIGHTLY: nightly ? "1" : "" },
    });
    const calls = spawnSync("cat", [log], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    return { status: result.status, out: `${result.stdout}${result.stderr}`, calls };
  }

  const onlyReads = (calls: string[]): boolean => calls.every((call) => call.startsWith("release view") || call.startsWith("release download"));

  test("a first stable release prints its tag, its addresses and the calls it would make, and reads alone", () => {
    const { status, out, calls } = dryRun("stable", "", false);

    expect(status).toBe(0);
    expect(out).toContain("desktop release 0.2.1 on stable → ahas/jake, tag desktop-v0.2.1");
    expect(out).toContain("updater feed   https://github.com/ahas/jake/releases/latest/download/latest.json");
    expect(out).toContain("console read   https://github.com/ahas/jake/releases/latest/download/release.json");
    expect(out).toContain("installer      https://github.com/ahas/jake/releases/download/desktop-v0.2.1/BMO_0.2.1_x64-setup.exe");
    expect(out).toContain("would run      gh release create desktop-v0.2.1 --repo ahas/jake --target ");
    expect(out).toContain("would run      gh release edit desktop-v0.2.1 --repo ahas/jake --draft=false --latest");
    expect(out).toContain("dry run: nothing built, uploaded or written");
    expect(onlyReads(calls)).toBe(true);
  });

  test("a stable version not above the published one is refused", () => {
    const { status, out } = dryRun("stable", "0.2.1", false);

    expect(status).toBe(1);
    expect(out).toContain("not higher than the published 0.2.1");
  });

  test("a nightly reads the nightly pre-release and would replace its assets and the stable's console read", () => {
    const { status, out, calls } = dryRun("nightly", "0.2.1", true);

    expect(status).toBe(0);
    expect(out).toMatch(/desktop release 0\.3\.0-nightly\.\d{8} on nightly → ahas\/jake, tag desktop-nightly/);
    expect(out).toContain("updater feed   https://github.com/ahas/jake/releases/download/desktop-nightly/latest.json");
    expect(out).toContain("would run      gh release delete-asset desktop-nightly BMO_0.3.0-nightly.20261101_amd64.deb --repo ahas/jake --yes");
    expect(out).toContain("would run      gh release upload desktop-v0.2.1 --repo ahas/jake --clobber");
    expect(calls).toContain("release view desktop-nightly --repo ahas/jake --json assets");
    expect(onlyReads(calls)).toBe(true);
  });

  test("a nightly before the first stable release is refused", () => {
    const { status, out } = dryRun("nightly", "", false);

    expect(status).toBe(1);
    expect(out).toContain("follows a release");
  });
});
