import { describe, expect, test } from "bun:test";

import {
  APPIMAGE,
  DEB,
  NSIS,
  type Installer,
  assertNewerVersion,
  releaseBaseUrl,
  releaseReads,
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
