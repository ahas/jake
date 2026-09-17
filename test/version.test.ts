import { expect, test } from "bun:test";

import { JAKE_VERSION } from "../src/version";

// Under a plain `bun` run — bun test applies no --define — the stamped global is absent and the
// module must fall back rather than throw on an undeclared identifier. The build stamps a real
// version into the compiled binaries; that path is covered by the build script producing binaries
// that carry the stamped string, not here.
test("falls back to a development version when nothing was stamped in", () => {
  expect(JAKE_VERSION).toBe("0.1.0-dev");
});
