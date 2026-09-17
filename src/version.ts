// The version string the compiled binaries report. The build step stamps it in by replacing the
// global __JAKE_VERSION__ at compile time (bun build --define); the token is guarded by typeof so a
// plain `bun` run in development, where no define was applied, falls back to a marked value rather
// than throwing on an undeclared global. This is what lets the agent announce its build to the hub
// and the guard record it in its log.

declare const __JAKE_VERSION__: string;

/** The build version, stamped at compile time or a development fallback under a plain `bun` run. */
export const JAKE_VERSION: string =
  typeof __JAKE_VERSION__ === "string" ? __JAKE_VERSION__ : "0.1.0-dev";
