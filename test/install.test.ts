// The Linux installer's answers to its three questions, driven through a pseudo-terminal.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install.sh");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// Run the installer with --print-config under `script`, so its prompts read a terminal fed `input`.
async function run(args: string[], input: string): Promise<{ code: number; output: string }> {
  const home = mkdtempSync(join(tmpdir(), "jake-install-"));
  homes.push(home);
  const command = ["bash", SCRIPT, "--print-config", ...args].map((part) => `'${part}'`).join(" ");
  const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 10_000);
  const [output, errors] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, output: output + errors };
}

describe("install.sh prompts", () => {
  test("an empty hub URL answer takes the shown default", async () => {
    const { code, output } = await run([], "\nsekrit\nnode2\n");
    expect(code).toBe(0);
    expect(output).toContain("Hub URL [default: wss://jake.example.org]:");
    expect(output).toContain("JAKE_HUB_URL=wss://jake.example.org");
    expect(output).toContain("JAKE_AGENT_NAME=node2");
  });

  test("the shared secret has no default and an empty answer stops the install", async () => {
    const { code, output } = await run(["--hub-url", "wss://example.test"], "\n\n");
    expect(code).not.toBe(0);
    expect(output).toContain("JAKE_SECRET is required.");
  });

  test("without a terminal the hub URL still falls back to the default", async () => {
    const { code, output } = await run(["--non-interactive", "--secret", "s", "--agent-name", "n"], "");
    expect(code).toBe(0);
    expect(output).toContain("JAKE_HUB_URL=wss://jake.example.org");
  });
});
