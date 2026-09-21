// The version string the compiled binaries report, stamped in at compile time.

declare const __JAKE_VERSION__: string;

/** The build version, stamped at compile time or a development fallback under a plain `bun` run. */
export const JAKE_VERSION: string =
  typeof __JAKE_VERSION__ === "string" ? __JAKE_VERSION__ : "0.1.0-dev";
