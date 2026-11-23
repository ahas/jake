// Publishing a release's agent build, and the deployment steps that build and publish it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Deployment, publishAgents, publishSettings } from "../scripts/publish-agents";
import declaration from "../testbed.toml";

const dirs: string[] = [];

const DEPLOYMENT: Deployment = { downloadUrl: "https://downloads.example.test/jake", hubUrl: "wss://hub.example.test" };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jake-publish-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("publishing the agent build", () => {
  test("every file of the build replaces the published one, and what else stands there is kept", () => {
    const from = folder({ "jake.exe": "new exe", jake: "new elf", "install.sh": "new script", "version.txt": "0.1.0+gnew\n" });
    const to = folder({ "jake.exe": "old exe", "version.txt": "0.1.0+gold\n" });
    mkdirSync(join(to, "desktop"));
    writeFileSync(join(to, "desktop", "latest.json"), "{}");

    expect(publishAgents(from, to, DEPLOYMENT)).toBe("0.1.0+gnew");
    expect(readFileSync(join(to, "jake.exe"), "utf8")).toBe("new exe");
    expect(readFileSync(join(to, "jake"), "utf8")).toBe("new elf");
    expect(readFileSync(join(to, "desktop", "latest.json"), "utf8")).toBe("{}");
    expect(readdirSync(to).sort()).toEqual(["desktop", "install.sh", "jake", "jake.exe", "version.txt"]);
  });

  test("a folder with no version file is no build, and nothing is published from it", () => {
    const from = folder({ "jake.exe": "new exe" });
    const to = folder({ "jake.exe": "old exe" });
    expect(() => publishAgents(from, to, DEPLOYMENT)).toThrow("version.txt is missing");
    expect(readFileSync(join(to, "jake.exe"), "utf8")).toBe("old exe");
  });
});

describe("the deployment's addresses", () => {
  test("are written into the installers it publishes, and into nothing else", () => {
    const script = 'BASE="@JAKE_AGENT_DOWNLOAD_URL@"\nDEFAULT_HUB_URL="@JAKE_PUBLIC_URL@"\n';
    const from = folder({ "install.sh": script, "install.ps1": script, "INSTALL.md": script, "version.txt": "0.1.0+g1\n" });
    const to = folder({});
    publishAgents(from, to, DEPLOYMENT);
    const filled = 'BASE="https://downloads.example.test/jake"\nDEFAULT_HUB_URL="wss://hub.example.test"\n';
    expect(readFileSync(join(to, "install.sh"), "utf8")).toBe(filled);
    expect(readFileSync(join(to, "install.ps1"), "utf8")).toBe(filled);
    expect(readFileSync(join(to, "INSTALL.md"), "utf8")).toBe(script);
  });

  test("come from the hub's settings alone, each one missing refused by its name", () => {
    const settings = {
      JAKE_PUBLISH_DIR: "/srv/published/jake",
      JAKE_AGENT_DOWNLOAD_URL: "https://downloads.example.test/jake/",
      JAKE_PUBLIC_URL: "wss://hub.example.test",
    };
    expect(publishSettings(settings)).toEqual({ to: "/srv/published/jake", deployment: DEPLOYMENT });
    for (const key of Object.keys(settings)) {
      expect(() => publishSettings({ ...settings, [key]: "" })).toThrow(`${key} is not set in the hub's settings`);
    }
  });

  test("stand in none of the repository's installers", () => {
    for (const name of ["install.sh", "install.ps1"]) {
      const text = readFileSync(join(import.meta.dir, "..", "scripts", name), "utf8");
      expect(text).toContain("@JAKE_AGENT_DOWNLOAD_URL@");
      expect(text).toContain("@JAKE_PUBLIC_URL@");
      expect(text).not.toMatch(/https?:\/\/|wss:\/\//);
    }
  });
});

describe("the deployment", () => {
  const steps = declaration as {
    build: { step: { id: string; command: string }[] };
    deploy: { step: { id: string; phase: string; command: string }[] };
  };

  test("builds the agents into its release and publishes them once the hub answers", () => {
    const build = steps.build.step.find((step) => step.id === "agents");
    expect(build?.command).toContain("bun scripts/build.ts --out ");
    expect(build?.command).toContain("/../deploy-releases/$(git rev-parse HEAD | cut -c1-12)/agents");
    const publish = steps.deploy.step.find((step) => step.id === "publish-agents");
    expect(publish?.phase).toBe("after-health");
    expect(publish?.command).toContain("bun scripts/publish-agents.ts");
  });
});
