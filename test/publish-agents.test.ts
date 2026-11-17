// Publishing a release's agent build, and the deployment steps that build and publish it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishAgents } from "../scripts/publish-agents";
import declaration from "../testbed.toml";

const dirs: string[] = [];

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

    expect(publishAgents(from, to)).toBe("0.1.0+gnew");
    expect(readFileSync(join(to, "jake.exe"), "utf8")).toBe("new exe");
    expect(readFileSync(join(to, "jake"), "utf8")).toBe("new elf");
    expect(readFileSync(join(to, "desktop", "latest.json"), "utf8")).toBe("{}");
    expect(readdirSync(to).sort()).toEqual(["desktop", "install.sh", "jake", "jake.exe", "version.txt"]);
  });

  test("a folder with no version file is no build, and nothing is published from it", () => {
    const from = folder({ "jake.exe": "new exe" });
    const to = folder({ "jake.exe": "old exe" });
    expect(() => publishAgents(from, to)).toThrow("version.txt is missing");
    expect(readFileSync(join(to, "jake.exe"), "utf8")).toBe("old exe");
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
