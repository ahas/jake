import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentFileEnv,
  hubEnvPath,
  hubFileEnv,
  loadAgentConfig,
  loadHubConfig,
  parseEnvFile,
  type Env,
} from "../src/config";

const fullAgent: Env = {
  JAKE_HUB_URL: "wss://jake.example.org",
  JAKE_SECRET: "s3cr3t",
  JAKE_AGENT_NAME: "hass-desktop",
};

const fullHub: Env = {
  JAKE_SECRET: "s3cr3t",
  JAKE_CONTROL_TOKEN: "c0nsole",
};

describe("loadAgentConfig", () => {
  test("reads the required keys and applies defaults", () => {
    const config = loadAgentConfig(fullAgent);
    expect(config.hubUrl).toBe("wss://jake.example.org");
    expect(config.secret).toBe("s3cr3t");
    expect(config.agentName).toBe("hass-desktop");
    expect(config.heartbeatMs).toBe(15_000);
    expect(config.tickMs).toBe(60_000);
    expect(config.watchdogStaleMs).toBe(180_000);
    expect(config.maxPayloadBytes).toBe(16 * 1024 * 1024);
    expect(config.execMaxOutputBytes).toBe(8 * 1024 * 1024);
    expect(config.execTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.fetchMaxBodyBytes).toBe(8 * 1024 * 1024);
    expect(config.fetchMaxRedirects).toBe(5);
    expect(config.browserSidecarDir).toBeNull();
    expect(config.browserIdleMs).toBe(5 * 60 * 1000);
    expect(config.browserCallTimeoutMs).toBe(60 * 1000);
  });

  test("honours overrides", () => {
    const config = loadAgentConfig({
      ...fullAgent,
      JAKE_HEARTBEAT_MS: "5000",
      JAKE_TICK_MS: "30000",
      JAKE_WATCHDOG_STALE_MS: "90000",
      JAKE_MAX_PAYLOAD_BYTES: "1048576",
      JAKE_EXEC_MAX_OUTPUT_BYTES: "2048",
      JAKE_EXEC_TIMEOUT_MS: "1000",
      JAKE_FETCH_MAX_BODY_BYTES: "4096",
      JAKE_FETCH_MAX_REDIRECTS: "0",
      JAKE_BROWSER_SIDECAR_DIR: "C:\\jake\\sidecar",
      JAKE_BROWSER_IDLE_MS: "90000",
      JAKE_BROWSER_CALL_TIMEOUT_MS: "30000",
    });
    expect(config.heartbeatMs).toBe(5000);
    expect(config.tickMs).toBe(30_000);
    expect(config.watchdogStaleMs).toBe(90_000);
    expect(config.maxPayloadBytes).toBe(1_048_576);
    expect(config.execMaxOutputBytes).toBe(2048);
    expect(config.execTimeoutMs).toBe(1000);
    expect(config.fetchMaxBodyBytes).toBe(4096);
    // A redirect bound of zero is a legitimate choice: follow none.
    expect(config.fetchMaxRedirects).toBe(0);
    expect(config.browserSidecarDir).toBe("C:\\jake\\sidecar");
    expect(config.browserIdleMs).toBe(90_000);
    expect(config.browserCallTimeoutMs).toBe(30_000);
  });

  test("rejects a non-positive exec cap by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_EXEC_MAX_OUTPUT_BYTES: "0" })).toThrow("JAKE_EXEC_MAX_OUTPUT_BYTES");
  });

  test("rejects a non-positive fetch body cap by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_FETCH_MAX_BODY_BYTES: "0" })).toThrow("JAKE_FETCH_MAX_BODY_BYTES");
  });

  test("rejects a negative redirect bound by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_FETCH_MAX_REDIRECTS: "-1" })).toThrow("JAKE_FETCH_MAX_REDIRECTS");
  });

  test("rejects a non-positive browser idle period by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_BROWSER_IDLE_MS: "0" })).toThrow("JAKE_BROWSER_IDLE_MS");
  });

  test("names a missing hub URL", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_HUB_URL: undefined })).toThrow("JAKE_HUB_URL");
  });

  test("names a missing secret", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_SECRET: "" })).toThrow("JAKE_SECRET");
  });

  test("names a missing agent name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_AGENT_NAME: undefined })).toThrow("JAKE_AGENT_NAME");
  });

  test("rejects a non-integer interval by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_HEARTBEAT_MS: "soon" })).toThrow("JAKE_HEARTBEAT_MS");
  });

  test("rejects a non-positive interval by name", () => {
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_TICK_MS: "0" })).toThrow("JAKE_TICK_MS");
    expect(() => loadAgentConfig({ ...fullAgent, JAKE_WATCHDOG_STALE_MS: "0" })).toThrow("JAKE_WATCHDOG_STALE_MS");
  });
});

describe("loadHubConfig", () => {
  test("reads the required keys and applies defaults", () => {
    const config = loadHubConfig(fullHub);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8790);
    expect(config.secret).toBe("s3cr3t");
    expect(config.controlPort).toBe(8791);
    expect(config.controlToken).toBe("c0nsole");
    expect(config.maxPayloadBytes).toBe(16 * 1024 * 1024);
  });

  test("honours overrides", () => {
    const config = loadHubConfig({ ...fullHub, JAKE_HUB_HOST: "127.0.0.1", JAKE_HUB_PORT: "9000", JAKE_CONTROL_PORT: "9001" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9000);
    expect(config.controlPort).toBe(9001);
  });

  test("names a missing secret", () => {
    expect(() => loadHubConfig({ ...fullHub, JAKE_SECRET: undefined })).toThrow("JAKE_SECRET");
  });

  test("names a missing control token", () => {
    expect(() => loadHubConfig({ ...fullHub, JAKE_CONTROL_TOKEN: "" })).toThrow("JAKE_CONTROL_TOKEN");
  });

  test("rejects a bad port by name", () => {
    expect(() => loadHubConfig({ ...fullHub, JAKE_HUB_PORT: "eighty" })).toThrow("JAKE_HUB_PORT");
  });
});

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

  test("feeds loadAgentConfig from a parsed file", () => {
    const env = parseEnvFile("JAKE_HUB_URL=wss://jake.example.org\nJAKE_SECRET=x\nJAKE_AGENT_NAME=box\n");
    const config = loadAgentConfig(env);
    expect(config.hubUrl).toBe("wss://jake.example.org");
    expect(config.agentName).toBe("box");
  });
});

describe("agentFileEnv", () => {
  test("reads agent.env beside the exe and feeds loadAgentConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-env-"));
    try {
      writeFileSync(
        join(dir, "agent.env"),
        "JAKE_HUB_URL=wss://jake.example.org\nJAKE_SECRET=s3cr3t\nJAKE_AGENT_NAME=box\n",
      );
      const env = agentFileEnv(dir, {});
      const config = loadAgentConfig(env);
      expect(config.hubUrl).toBe("wss://jake.example.org");
      expect(config.secret).toBe("s3cr3t");
      expect(config.agentName).toBe("box");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a variable set in the environment overrides the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-env-"));
    try {
      writeFileSync(join(dir, "agent.env"), "JAKE_HUB_URL=wss://from-file\n");
      const env = agentFileEnv(dir, { JAKE_HUB_URL: "wss://from-env" });
      expect(env.JAKE_HUB_URL).toBe("wss://from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no file beside the exe the process environment stands alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-env-"));
    try {
      const passed: Env = { JAKE_HUB_URL: "wss://only-env" };
      expect(agentFileEnv(dir, passed)).toBe(passed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test("reads the file JAKE_HUB_ENV points at and feeds loadHubConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "jake-hub-env-"));
    try {
      const file = join(dir, "hub.env");
      writeFileSync(file, "JAKE_SECRET=shared\nJAKE_CONTROL_TOKEN=ctl\nJAKE_HUB_PORT=9001\n");
      const env = hubFileEnv({ JAKE_HUB_ENV: file });
      const config = loadHubConfig(env);
      expect(config.secret).toBe("shared");
      expect(config.controlToken).toBe("ctl");
      expect(config.port).toBe(9001);
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
