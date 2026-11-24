import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALL_IN_ONE,
  APPIMAGE,
  APPS,
  DEB,
  NSIS,
  REMOTE_CONTROLLER,
  type Installer,
  type ReleaseRead,
  type GitHubPublication,
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
  updateEndpoint,
  updateServerCalls,
  updateServerOf,
  versionBaseUrl,
  withChannelRelease,
} from "../scripts/desktop-manifest";

// A mirror folder's served address, as the owner's server serves it.
const base = new URL("https://mirror.example/bmo/jake/desktop/");
const remoteFeed = feedOf("https://github.com/ahas/jake/releases/latest/download/latest.json");
const allInOneFeed = feedOf("https://github.com/ahas/jake/releases/latest/download/all-in-one-latest.json");
const repository = repositoryOf([remoteFeed, allInOneFeed]);
const date = new Date("2026-11-16T12:00:00Z");
const installersOf = (product: string, sizes: number): Installer[] =>
  [NSIS, APPIMAGE, DEB].map((kind, i) => ({
    kind,
    file: assetName(kind.fileName(product, "0.2.0")),
    size: sizes + i,
    sha256: `${i}`.repeat(64),
    signature: `sig-${kind.format}`,
  }));
const installers = installersOf("BMO", 1000);
const remoteOnly = [{ app: REMOTE_CONTROLLER, feedFile: "latest.json", installers }];
const bothApps = [
  ...remoteOnly,
  { app: ALL_IN_ONE, feedFile: "all-in-one-latest.json", installers: installersOf("BMO All-in-One", 2000) },
];

describe("feedOf and repositoryOf", () => {
  test("each app's feed is a file of the latest release, and the repository the one they all name", () => {
    expect(remoteFeed.file).toBe("latest.json");
    expect(allInOneFeed.file).toBe("all-in-one-latest.json");
    expect(repository.slug).toBe("ahas/jake");
  });

  test("refuses an endpoint that is not a GitHub latest release's feed", () => {
    for (const endpoint of [
      "https://mirror.example/bmo/jake/desktop/latest.json",
      "https://github.com/ahas/jake/releases/download/desktop-v1.0.0/latest.json",
      "https://github.com/ahas/jake/releases/latest/download/feed.json",
      "https://example.com/ahas/jake/releases/latest/download/latest.json",
    ]) {
      expect(() => feedOf(endpoint)).toThrow("latest release feed");
    }
  });

  test("refuses apps whose feeds name different repositories or one file", () => {
    const elsewhere = feedOf("https://github.com/someone/else/releases/latest/download/all-in-one-latest.json");
    expect(() => repositoryOf([remoteFeed, elsewhere])).toThrow("different repositories");
    expect(() => repositoryOf([remoteFeed, remoteFeed])).toThrow("one file");
  });

  test("every app the release builds has a feed of its own, the remote controller's the configuration's own", () => {
    expect(APPS).toEqual([REMOTE_CONTROLLER, ALL_IN_ONE]);
    expect(ALL_IN_ONE.overlay).toBe("tauri.all-in-one.conf.json");
    expect(ALL_IN_ONE.features).toEqual(["all-in-one"]);
  });
});

describe("assetName", () => {
  test("is the built name with the product's spaces as dashes, since GitHub rewrites spaces", () => {
    expect(assetName(APPIMAGE.fileName("BMO All-in-One", "1.0.0"))).toBe("BMO-All-in-One_1.0.0_amd64.AppImage");
    expect(assetName(NSIS.fileName("BMO", "1.0.0"))).toBe("BMO_1.0.0_x64-setup.exe");
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
    const { release, feeds } = releaseReads("1.0.0", date, assetBaseUrl(repository, "desktop-v1.0.0"), bothApps);

    expect(release.files[0]?.url).toBe("https://github.com/ahas/jake/releases/download/desktop-v1.0.0/BMO_0.2.0_x64-setup.exe");
    expect(feeds[0]?.feed.platforms["linux-x86_64-deb"]?.url).toBe(
      "https://github.com/ahas/jake/releases/download/desktop-v1.0.0/BMO_0.2.0_amd64.deb",
    );
    expect(release.allInOne?.files[1]?.url).toBe(
      "https://github.com/ahas/jake/releases/download/desktop-v1.0.0/BMO-All-in-One_0.2.0_amd64.AppImage",
    );
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
    feeds: ["s/latest.json", "s/all-in-one-latest.json"],
    consoleRead: "s/console/release.json",
    stableVersion: null,
    nightlyAssets: null,
  };

  test("a stable release is drafted with its installers, feed and console read, then published as the latest", () => {
    expect(githubCalls(publication)).toEqual([
      [
        "release", "create", "desktop-v1.0.0", "--repo", "ahas/jake", "--target", "abc123", "--title", "BMO desktop 1.0.0",
        "--notes", "BMO desktop app 1.0.0, built from abc123.", "--draft",
        "s/BMO_1.0.0_x64-setup.exe", "s/BMO_1.0.0_x64-setup.exe.sig", "s/latest.json", "s/all-in-one-latest.json",
        "s/console/release.json",
      ],
      ["release", "edit", "desktop-v1.0.0", "--repo", "ahas/jake", "--draft=false", "--latest"],
    ]);
  });

  test("the first nightly makes the pre-release, then puts the console read on the latest stable release", () => {
    const calls = githubCalls({ ...publication, channel: "nightly", version: "1.1.0-nightly.20261124", stableVersion: "1.0.0" });

    expect(calls[0]?.slice(0, 7)).toEqual(["release", "create", "desktop-nightly", "--repo", "ahas/jake", "--target", "abc123"]);
    expect(calls[0]).toContain("--prerelease");
    expect(calls[0]?.slice(-5)).toEqual([
      "s/BMO_1.0.0_x64-setup.exe",
      "s/BMO_1.0.0_x64-setup.exe.sig",
      "s/release.json",
      "s/latest.json",
      "s/all-in-one-latest.json",
    ]);
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
    expect(calls[1]?.slice(-2)).toEqual(["s/latest.json", "s/all-in-one-latest.json"]);
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
  const { release, feeds } = releaseReads("0.2.0", date, versionBaseUrl(base, "0.2.0"), remoteOnly);
  const feed = feeds[0]!.feed;

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
    const twice = [{ app: REMOTE_CONTROLLER, feedFile: "latest.json", installers: [installers[1]!, installers[1]!] }];
    expect(() => releaseReads("0.2.0", date, versionBaseUrl(base, "0.2.0"), twice)).toThrow("two installers");
  });

  test("the all-in-one's installers stand under allInOne, each app with its own feed", () => {
    const both = releaseReads("0.2.0", date, versionBaseUrl(base, "0.2.0"), bothApps);

    expect(both.release.files).toEqual(release.files);
    expect(both.release.allInOne?.files.map((file) => file.file)).toEqual([
      "BMO-All-in-One_0.2.0_x64-setup.exe",
      "BMO-All-in-One_0.2.0_amd64.AppImage",
      "BMO-All-in-One_0.2.0_amd64.deb",
    ]);
    expect(both.feeds.map((one) => one.file)).toEqual(["latest.json", "all-in-one-latest.json"]);
    expect(both.feeds[1]?.feed.platforms["linux-x86_64"]?.url).toBe(
      "https://mirror.example/bmo/jake/desktop/0.2.0/BMO-All-in-One_0.2.0_amd64.AppImage",
    );
    expect(both.feeds[1]?.feed.version).toBe("0.2.0");
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
    const { release, feeds } = releaseReads("1.1.0-nightly.20261124", date, nightly, bothApps);

    expect(release.files[0]?.url).toBe(
      "https://mirror.example/bmo/jake/desktop/nightly/1.1.0-nightly.20261124/BMO_0.2.0_x64-setup.exe",
    );
    expect(feeds[0]?.feed.platforms["windows-x86_64"]?.url).toBe(release.files[0]?.url);
    expect(feeds[1]?.feed.platforms["windows-x86_64"]?.url).toBe(release.allInOne?.files[0]?.url);
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
  const stable = "1.0.0";
  const nightly = "1.1.0-nightly.20261124";

  test("takes a nightly above both channels", () => {
    expect(() => assertNightlyVersion("1.1.0-nightly.20261125", stable, nightly)).not.toThrow();
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", stable, null)).not.toThrow();
  });

  test("refuses one before the first release, not above the nightly, or behind the stable", () => {
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", null, null)).toThrow("follows a release");
    expect(() => assertNightlyVersion("1.1.0-nightly.20261124", stable, nightly)).toThrow("not higher");
    expect(() => assertNightlyVersion("1.1.0-nightly.20261123", stable, nightly)).toThrow("not higher");
    expect(() => assertNightlyVersion("1.0.0-nightly.20261126", stable, null)).toThrow("not higher");
  });
});

describe("the update server", () => {
  const publisher = (address: string): string =>
    `BMO_UPDATE_ADDRESS=${address}\nBMO_UPDATE_PUBLISH_ADDRESS=http://127.0.0.1:9/\nBMO_UPDATE_TOKEN=a=b\n`;

  test("is named by the publisher's file, each value read verbatim after its key", () => {
    const server = updateServerOf(publisher("https://updates.example/bmo-update"), "file");

    expect(server.address.href).toBe("https://updates.example/bmo-update/");
    expect(server.publishAddress.href).toBe("http://127.0.0.1:9/");
    expect(server.token).toBe("a=b");
  });

  test("refuses a file missing a line, and a public address that is not HTTPS", () => {
    expect(() => updateServerOf("BMO_UPDATE_ADDRESS=https://updates.example/\n", "file")).toThrow("BMO_UPDATE_PUBLISH_ADDRESS");
    expect(() => updateServerOf(publisher("http://updates.example/"), "file")).toThrow("not HTTPS");
  });

  test("every app is built to ask its own product's stable endpoint", () => {
    const server = updateServerOf(publisher("https://updates.example/u/"), "file");

    expect(updateEndpoint(server, REMOTE_CONTROLLER)).toBe(
      "https://updates.example/u/updates/bmo-desktop/stable/{{target}}/{{arch}}/{{current_version}}?bundleType={{bundle_type}}",
    );
    expect(updateEndpoint(server, ALL_IN_ONE)).toContain("/updates/bmo-all-in-one/stable/");
  });

  test("a release declares both products, drafts each with its installers, then puts the companion live first", () => {
    const calls = updateServerCalls("nightly", "1.1.0-nightly.20261124", "abc", [
      { app: REMOTE_CONTROLLER, title: "BMO", files: ["BMO.exe", "BMO.AppImage"] },
      { app: ALL_IN_ONE, title: "BMO All-in-One", files: ["BMO-All-in-One.exe"] },
    ]).map(shownCall);

    expect(calls).toEqual([
      'PUT products/bmo-desktop {"title":"BMO","channels":[{"name":"stable","includes":[]},{"name":"nightly","includes":["stable"]}],"companions":{"allInOne":"bmo-all-in-one"}}',
      'PUT products/bmo-all-in-one {"title":"BMO All-in-One","channels":[{"name":"stable","includes":[]},{"name":"nightly","includes":["stable"]}],"companions":{}}',
      'PUT products/bmo-desktop/releases/1.1.0-nightly.20261124 {"channel":"nightly","notes":"BMO desktop app 1.1.0-nightly.20261124, built from abc.","commit":"abc"}',
      "PUT products/bmo-desktop/releases/1.1.0-nightly.20261124/files/BMO.exe <installer declaration>",
      "PUT products/bmo-desktop/releases/1.1.0-nightly.20261124/files/BMO.exe/content <installer bytes>",
      "PUT products/bmo-desktop/releases/1.1.0-nightly.20261124/files/BMO.AppImage <installer declaration>",
      "PUT products/bmo-desktop/releases/1.1.0-nightly.20261124/files/BMO.AppImage/content <installer bytes>",
      'PUT products/bmo-all-in-one/releases/1.1.0-nightly.20261124 {"channel":"nightly","notes":"BMO desktop app 1.1.0-nightly.20261124, built from abc.","commit":"abc"}',
      "PUT products/bmo-all-in-one/releases/1.1.0-nightly.20261124/files/BMO-All-in-One.exe <installer declaration>",
      "PUT products/bmo-all-in-one/releases/1.1.0-nightly.20261124/files/BMO-All-in-One.exe/content <installer bytes>",
      'PATCH products/bmo-all-in-one/releases/1.1.0-nightly.20261124 {"state":"live"}',
      'PATCH products/bmo-desktop/releases/1.1.0-nightly.20261124 {"state":"live"}',
    ]);
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

describe("the release's dry run", () => {
  // A stand-in `gh` on the PATH: it answers the repository's visibility from FAKE_GH_VISIBILITY and the reads of the
  // published releases from FAKE_GH_PUBLISHED (a stable version, or nothing) and FAKE_GH_NIGHTLY (whether the nightly
  // pre-release stands), logs every call it is given, and refuses anything else, so a dry run that would write is
  // seen. A stand-in update server answers each channel's newest version from `onServer` and logs every request.
  const root = mkdtempSync(join(tmpdir(), "jake-desktop-release-dry-"));
  const bin = join(root, "bin");
  const keys = join(root, "keys");
  const log = join(root, "gh.log");
  const onServer: Record<string, string | null> = { stable: null, nightly: null };
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      asked.push(`${request.method} ${url.pathname}${url.search}`);
      const channel = url.searchParams.get("channel") ?? "";
      if (request.method !== "GET" || url.pathname !== "/products/bmo-desktop/releases") {
        return new Response("unexpected", { status: 500 });
      }
      const version = onServer[channel] ?? null;
      return Response.json({ items: version === null ? [] : [{ version }], more: false });
    },
  });
  spawnSync("mkdir", ["-p", bin, keys]);
  writeFileSync(join(keys, "jake-desktop-updater.key"), "not a key");
  writeFileSync(join(keys, "jake-desktop-updater.password"), "not a password");
  writeFileSync(
    join(keys, "update-publisher.env"),
    `BMO_UPDATE_ADDRESS=https://updates.example/bmo-update/\nBMO_UPDATE_PUBLISH_ADDRESS=http://127.0.0.1:${server.port}/\nBMO_UPDATE_TOKEN=not a token\n`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "repo view ahas/jake --json visibility")
    echo "{\\"visibility\\":\\"\${FAKE_GH_VISIBILITY:-PRIVATE}\\"}" ;;
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

  interface Run {
    status: number | null;
    out: string;
    calls: string[];
  }

  async function release(channel: string, github: { visibility: string; published: string; nightly: boolean }, extra: string[] = ["--dry-run"]): Promise<Run> {
    rmSync(log, { force: true });
    asked.length = 0;
    const run = Bun.spawn(["bun", "scripts/desktop-release.ts", "--channel", channel, "--keys", keys, ...extra], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_GH_VISIBILITY: github.visibility,
        FAKE_GH_PUBLISHED: github.published,
        FAKE_GH_NIGHTLY: github.nightly ? "1" : "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    const calls = spawnSync("cat", [log], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    return { status, out: `${stdout}${stderr}`, calls };
  }

  const PRIVATE = { visibility: "PRIVATE", published: "", nightly: false };
  const onlyReads = (calls: string[]): boolean =>
    calls.every((call) => call.startsWith("repo view") || call.startsWith("release view") || call.startsWith("release download"));
  const onlyServerReads = (): boolean => asked.every((request) => request.startsWith("GET "));

  test("a first stable release of a private repository names the update server alone, and reads alone", async () => {
    onServer.stable = null;
    onServer.nightly = null;
    const { status, out, calls } = await release("stable", PRIVATE);

    expect(status).toBe(0);
    expect(out).toContain("desktop release 0.2.1 on stable → the update server https://updates.example/bmo-update/");
    expect(out).toContain(
      "endpoint       https://updates.example/bmo-update/updates/bmo-desktop/stable/{{target}}/{{arch}}/{{current_version}}?bundleType={{bundle_type}} (remote controller)",
    );
    expect(out).toContain("/updates/bmo-all-in-one/stable/");
    expect(out).toContain("download read  https://updates.example/bmo-update/products/bmo-desktop/download");
    expect(out).toContain("GitHub         ahas/jake is private, so nothing is published there");
    expect(out).toContain("would call     PUT products/bmo-desktop/releases/0.2.1/files/BMO_0.2.1_x64-setup.exe/content <installer bytes>");
    expect(out).toContain('would call     PATCH products/bmo-desktop/releases/0.2.1 {"state":"live"}');
    expect(out).not.toContain("would run      gh");
    expect(out).toContain("dry run: nothing built, uploaded or written");
    expect(out).not.toContain("not a token");
    expect(calls).toEqual(["repo view ahas/jake --json visibility"]);
    expect(asked).toContain("GET /products/bmo-desktop/releases?channel=stable&limit=1");
    expect(onlyServerReads()).toBe(true);
  });

  test("a public repository is published on GitHub as well", async () => {
    onServer.stable = null;
    const { status, out, calls } = await release("stable", { visibility: "PUBLIC", published: "", nightly: false });

    expect(status).toBe(0);
    expect(out).toContain("GitHub         ahas/jake, tag desktop-v0.2.1");
    expect(out).toContain("updater feed   https://github.com/ahas/jake/releases/latest/download/latest.json (remote controller)");
    expect(out).toContain("installer      https://github.com/ahas/jake/releases/download/desktop-v0.2.1/BMO_0.2.1_x64-setup.exe");
    expect(out).toContain("'<staging>/latest.json' '<staging>/all-in-one-latest.json' '<staging>/console/release.json'");
    expect(out).toContain("would run      gh release create desktop-v0.2.1 --repo ahas/jake --target ");
    expect(out).toContain("would run      gh release edit desktop-v0.2.1 --repo ahas/jake --draft=false --latest");
    expect(onlyReads(calls)).toBe(true);
  });

  test("a stable version not above the update server's is refused", async () => {
    onServer.stable = "0.2.1";
    const { status, out } = await release("stable", PRIVATE);

    expect(status).toBe(1);
    expect(out).toContain("not higher than the published 0.2.1");
  });

  test("a nightly counts above the update server's nightly and replaces GitHub's pre-release where public", async () => {
    onServer.stable = "0.2.1";
    onServer.nightly = null;
    const { status, out, calls } = await release("nightly", { visibility: "PUBLIC", published: "0.2.1", nightly: true });

    expect(status).toBe(0);
    expect(out).toMatch(/desktop release 0\.3\.0-nightly\.\d{8} on nightly → the update server/);
    expect(out).toContain("updater feed   https://github.com/ahas/jake/releases/download/desktop-nightly/latest.json");
    expect(out).toContain("would run      gh release delete-asset desktop-nightly BMO_0.3.0-nightly.20261101_amd64.deb --repo ahas/jake --yes");
    expect(out).toContain("would run      gh release upload desktop-v0.2.1 --repo ahas/jake --clobber");
    expect(out).toMatch(/would call {5}PUT products\/bmo-desktop\/releases\/0\.3\.0-nightly\.\d{8} \{"channel":"nightly"/);
    expect(calls).toContain("release view desktop-nightly --repo ahas/jake --json assets");
    expect(onlyReads(calls)).toBe(true);
    expect(asked).toContain("GET /products/bmo-desktop/releases?channel=nightly&limit=1");
  });

  test("a public repository with no stable release on GitHub takes no nightly there", async () => {
    onServer.stable = "0.2.1";
    const { status, out } = await release("nightly", { visibility: "PUBLIC", published: "", nightly: false });

    expect(status).toBe(0);
    expect(out).toContain("holds no stable release, so no nightly is published there");
    expect(out).not.toContain("would run      gh");
  });

  test("--no-publish takes neither --dry-run nor a mirror", async () => {
    for (const extra of [["--dry-run"], ["--mirror", root, "--mirror-url", "https://mirror.example/"]]) {
      const { status, out } = await release("stable", PRIVATE, ["--no-publish", join(root, "out"), ...extra]);
      expect(status).toBe(1);
      expect(out).toContain("usage:");
    }
  });

  test("a nightly before the first stable release is refused", async () => {
    onServer.stable = null;
    onServer.nightly = null;
    const { status, out } = await release("nightly", PRIVATE);

    expect(status).toBe(1);
    expect(out).toContain("follows a release");
  });

  test("a release with no publisher's file stops before anything", async () => {
    const { status, out } = await release("stable", PRIVATE, ["--dry-run", "--publisher", join(root, "missing.env")]);

    expect(status).toBe(1);
    expect(out).toContain("publisher's file");
  });
});
