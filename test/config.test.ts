import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hubEnvPath,
  hubFileEnv,
  loadConsoleConfig,
  parseEnvFile,
  type Env,
} from "../src/config";

describe("parseEnvFile", () => {
  test("parses keys, skips comments and blanks, strips quotes", () => {
    const text = [
      "# a comment",
      "",
      "JAKE_HUB_URL=wss://jake.example.org",
      "  JAKE_SECRET = s3cr3t  ",
      'JAKE_AGENT_NAME="hass desktop"',
      "JAKE_TICK_MS='60000'",
      "NO_EQUALS_LINE",
    ].join("\n");
    const env = parseEnvFile(text);
    expect(env.JAKE_HUB_URL).toBe("wss://jake.example.org");
    expect(env.JAKE_SECRET).toBe("s3cr3t");
    expect(env.JAKE_AGENT_NAME).toBe("hass desktop");
    expect(env.JAKE_TICK_MS).toBe("60000");
    expect("NO_EQUALS_LINE" in env).toBe(false);
  });
});

describe("hubEnvPath", () => {
  test("defaults to hub.env under the data directory", () => {
    const path = hubEnvPath({});
    expect(path.endsWith(join(".local", "share", "jake", "hub.env"))).toBe(true);
  });

  test("JAKE_HUB_ENV overrides the default", () => {
    expect(hubEnvPath({ JAKE_HUB_ENV: "/tmp/elsewhere/hub.env" })).toBe("/tmp/elsewhere/hub.env");
  });
});

describe("hubFileEnv", () => {
  test("reads the file JAKE_HUB_ENV points at and feeds loadConsoleConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-hub-env-"));
    try {
      const file = join(dir, "hub.env");
      writeFileSync(file, "JAKE_SECRET=shared\nJAKE_CONTROL_TOKEN=ctl\nJAKE_CONTROL_PORT=9001\n");
      const env = hubFileEnv({ JAKE_HUB_ENV: file });
      const config = loadConsoleConfig(env);
      expect(config.controlToken).toBe("ctl");
      expect(config.controlPort).toBe(9001);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a variable set in the environment overrides the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-hub-env-"));
    try {
      const file = join(dir, "hub.env");
      writeFileSync(file, "JAKE_SECRET=from-file\n");
      const env = hubFileEnv({ JAKE_HUB_ENV: file, JAKE_SECRET: "from-env" });
      expect(env.JAKE_SECRET).toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no file present the process environment stands alone", () => {
    const passed: Env = { JAKE_HUB_ENV: join(tmpdir(), "jake-absent", "hub.env"), JAKE_SECRET: "only-env" };
    expect(hubFileEnv(passed)).toBe(passed);
  });
});
