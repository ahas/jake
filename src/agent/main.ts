// The agent's entry point on 하스's Windows box. It reads the single environment file beside the
// executable, wires the real seams — a WebSocket dialer, the system clock, a rolling file log —
// registers whatever capabilities this build carries, and hands control to the reconnect loop, which
// dials the hub and keeps the connection alive without end. Nothing here is a credential: the hub
// URL and the shared secret come from the config file. This file is compiled into the Windows
// executable by the build step; the capability registrations below are filled in by their own build
// stages.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentConfig } from "../config";
import { agentFileEnv, loadAgentConfig } from "../config";
import { JAKE_VERSION } from "../version";
import { browserHandlers, BrowserSupervisor, bunSidecarSpawner, type SidecarSpawner } from "./browser";
import { ShellRunner, windowsSpawner } from "./exec";
import { FetchHandler } from "./fetch";
import { acquireInstanceLock, diskLockFs, releaseInstanceLock, systemPidAlive } from "./instance";
import { agentLogPath } from "./platform";
import { fileLogger } from "./log";
import { buildWatchdog, lockPath } from "./persistence";
import { AgentRuntime } from "./runtime";
import { bunCaptureSpawner, diskScreenshotFs, ScreenshotHandler, tempPngPath } from "./screenshot";
import { systemScheduler, WebSocketDialer } from "./transport";
import type { Watchdog } from "./watchdog";

/** This agent build's version, announced to the hub in the hello. Stamped in at compile time. */
const AGENT_VERSION = JAKE_VERSION;

function main(): void {
  const config = loadAgentConfig(agentFileEnv(dirname(process.execPath)));
  const log = fileLogger(agentLogPath(process.platform, process.env));

  const runtime = new AgentRuntime(config, {
    dialer: new WebSocketDialer(),
    scheduler: systemScheduler,
    log,
    agentVersion: AGENT_VERSION,
  });

  // Capabilities register here, each contributing its own name to the hello list. The shell runner
  // (exec/cancel) runs PowerShell and WSL commands through the Windows spawner, holding to the
  // configured output and time caps. The browser handler is built by its own stage and slotted in
  // at this point:
  //   runtime.registerCall(new BrowserHandler(...));
  runtime.registerExec(
    new ShellRunner({
      spawner: windowsSpawner,
      scheduler: systemScheduler,
      log,
      maxOutputBytes: config.execMaxOutputBytes,
      timeoutMs: config.execTimeoutMs,
    }),
  );

  // The screenshot handler photographs the desktop through PowerShell, with a bundled nircmd.exe as
  // its fallback when policy blocks that path. The nircmd binary is laid down beside the executable
  // by the installer; when it is not there the handler still runs and reports a stated error rather
  // than a fallback. The fetch handler retrieves a URL from inside 하스's network, holding to the
  // configured body and redirect bounds.
  runtime.registerCall(
    new ScreenshotHandler({
      spawner: bunCaptureSpawner,
      fs: diskScreenshotFs(),
      tempPath: tempPngPath,
      nircmdPath: resolveNircmdPath(),
      maxPayloadBytes: config.maxPayloadBytes,
    }),
  );
  runtime.registerCall(
    new FetchHandler({
      maxBodyBytes: config.fetchMaxBodyBytes,
      maxRedirects: config.fetchMaxRedirects,
      maxPayloadBytes: config.maxPayloadBytes,
    }),
  );

  // The browser capability lives in the sidecar the installer lays down beside the executable. When
  // that directory and its downloaded browser are present the supervisor drives them; when they are
  // not, the supervisor is unavailable, the browser methods are registered but not advertised, and a
  // call to one comes back as a stated "install it" error instead of a crash.
  const supervisor = new BrowserSupervisor({
    spawner: resolveSidecarSpawner(config),
    scheduler: systemScheduler,
    log,
    idleMs: config.browserIdleMs,
    callTimeoutMs: config.browserCallTimeoutMs,
    installHint:
      "the browser sidecar is not installed; run the installer's browser download (playwright install) to enable browser.* capabilities",
  });
  const advertiseBrowser = supervisor.available();
  for (const handler of browserHandlers(supervisor, config.maxPayloadBytes)) {
    runtime.registerCall(handler, { advertise: advertiseBrowser });
  }

  // Staying alive is a Windows-only scheme: its anchors are Windows registrations and its watchdog
  // relaunches through the Task Scheduler. Off Windows — where the agent runs only under test — there
  // are no anchors to keep and no duplicate-launch risk, so neither the single-instance guard nor the
  // watchdog is started.
  const persistence = startPersistence(config, log);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      persistence?.stop();
      supervisor.stop();
      runtime.stop();
      process.exit(0);
    });
  }

  log.log("info", "agent-starting", { hubUrl: config.hubUrl, agent: config.agentName, version: AGENT_VERSION });
  void runtime.run();
}

/**
 * Start the single-instance guard and the watchdog that watches the guard binary, or nothing off
 * Windows. Only one agent runs at a time — the three anchors all fire at one logon, so the first copy
 * takes the lock and the rest exit. The returned handle stops the watchdog and releases the lock on
 * a clean exit; a crash leaves the lock for the pid check to reclaim. Returns null when there is
 * nothing to start.
 */
function startPersistence(config: AgentConfig, log: ReturnType<typeof fileLogger>): { stop(): void } | null {
  if (process.platform !== "win32") {
    return null;
  }

  const lock = lockPath(process.platform, process.env, "agent");
  const lockFs = diskLockFs();
  if (!acquireInstanceLock({ path: lock, pid: process.pid, fs: lockFs, pidAlive: systemPidAlive })) {
    log.log("info", "agent-already-running", {});
    process.exit(0);
  }

  const watchdog: Watchdog = buildWatchdog("agent", {
    config,
    platform: process.platform,
    env: process.env,
    installDir: dirname(process.execPath),
    scheduler: systemScheduler,
    log,
  });
  watchdog.start();

  return {
    stop() {
      watchdog.stop();
      releaseInstanceLock(lock, lockFs);
    },
  };
}

/**
 * Locate the bundled nircmd.exe the screenshot handler falls back to. The installer places it beside
 * the executable; when it is present the handler uses it as a fallback, and when it is absent the
 * handler reports a stated error instead of a capture. Under a plain `bun` run — not the compiled
 * exe — it is not there, so the fallback is simply unavailable in development.
 */
function resolveNircmdPath(): string | null {
  const candidate = join(dirname(process.execPath), "nircmd.exe");
  return existsSync(candidate) ? candidate : null;
}

/**
 * Build the spawner for the browser sidecar, or null when it is not installed here. The sidecar is a
 * directory the installer lays down beside the executable — its own entry, its own bun runtime, and
 * its own downloaded browser. It counts as installed only when both the entry and the browser
 * directory are present; a directory without the downloaded browser is treated as absent, so the
 * capability is not advertised until the browser is really there. The sidecar's own bun runs it; a
 * bun on PATH is the development fallback when none was shipped beside it.
 */
function resolveSidecarSpawner(config: AgentConfig): SidecarSpawner | null {
  const dir = config.browserSidecarDir ?? join(dirname(process.execPath), "sidecar");
  const entry = join(dir, "index.ts");
  const browsers = join(dir, "browsers");
  if (!existsSync(entry) || !existsSync(browsers)) {
    return null;
  }
  const shippedBun = join(dir, process.platform === "win32" ? "bun.exe" : "bun");
  const command = existsSync(shippedBun) ? [shippedBun, entry] : ["bun", entry];
  return bunSidecarSpawner(command, dir);
}

main();
