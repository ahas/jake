import { describe, expect, test } from "bun:test";

import {
  APPIMAGE,
  DEB,
  NSIS,
  type ConsoleRead,
  type Installer,
  type ReleaseRead,
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
} from "../scripts/desktop-manifest";

const base = releaseBaseUrl("https://ai.example.org/bmo/jake/desktop/latest.json");
const date = new Date("2026-11-16T12:00:00Z");
const installers: Installer[] = [NSIS, APPIMAGE, DEB].map((kind, i) => ({
  kind,
  file: kind.fileName("BMO", "0.2.0"),
  size: 1000 + i,
  sha256: `${i}`.repeat(64),
  signature: `sig-${kind.format}`,
}));

describe("releaseBaseUrl", () => {
  test("is the folder holding the updater's feed", () => {
    expect(base.href).toBe("https://ai.example.org/bmo/jake/desktop/");
  });

  test("refuses an endpoint that is not a latest.json feed", () => {
    expect(() => releaseBaseUrl("https://ai.example.org/bmo/jake/desktop/feed.json")).toThrow("latest.json");
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
  const { release, feed } = releaseReads("0.2.0", date, base, installers);

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
          url: "https://ai.example.org/bmo/jake/desktop/0.2.0/BMO_0.2.0_x64-setup.exe",
        },
        {
          platform: "linux",
          arch: "x86_64",
          format: "appimage",
          file: "BMO_0.2.0_amd64.AppImage",
          size: 1001,
          sha256: "1".repeat(64),
          url: "https://ai.example.org/bmo/jake/desktop/0.2.0/BMO_0.2.0_amd64.AppImage",
        },
        {
          platform: "linux",
          arch: "x86_64",
          format: "deb",
          file: "BMO_0.2.0_amd64.deb",
          size: 1002,
          sha256: "2".repeat(64),
          url: "https://ai.example.org/bmo/jake/desktop/0.2.0/BMO_0.2.0_amd64.deb",
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
    expect(() => releaseReads("0.2.0", date, base, [installers[1]!, installers[1]!])).toThrow("two installers");
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
    expect(channelBaseUrl(base, "stable").href).toBe("https://ai.example.org/bmo/jake/desktop/");
    expect(channelBaseUrl(base, "nightly").href).toBe("https://ai.example.org/bmo/jake/desktop/nightly/");
  });

  test("a nightly's feed and read name its own folder", () => {
    const { release, feed } = releaseReads("1.1.0-nightly.20261124", date, channelBaseUrl(base, "nightly"), installers);

    expect(release.files[0]?.url).toBe(
      "https://ai.example.org/bmo/jake/desktop/nightly/1.1.0-nightly.20261124/BMO_0.2.0_x64-setup.exe",
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
