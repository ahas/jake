// The browser sidecar's entry point: an ordinary Bun program the agent spawns as a child. It reads
// one JSON request per line on standard input, dispatches each to the playwright driver one at a
// time — a single browser page cannot serve two overlapping calls — and writes one JSON response per
// line on standard output. It never opens a listening port; its whole conversation is over the two
// standard streams the agent already holds. The installer lays this file down beside the agent's
// executable with its own node_modules and a co-located browser, which this program points playwright
// at through PLAYWRIGHT_BROWSERS_PATH so the browser it drives is the one shipped in its own directory.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PlaywrightDriver } from "./driver";
import { dispatch, formatResponseLine, LineSplitter, parseRequestLine } from "./rpc";

const here = dirname(fileURLToPath(import.meta.url));

// Point playwright at the browser shipped in this sidecar's own directory rather than a machine-wide
// cache, so the sidecar is self-contained and the install's downloaded browser is the one it drives.
// A value already in the environment — as a test on this machine sets — is left alone.
if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(here, "browsers");
}

function writeResponse(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const driver = new PlaywrightDriver({
    // A headless container commonly cannot use the sandbox; the flags keep a fresh Windows or Linux
    // box from failing to launch for want of it. On 하스's desktop they are harmless.
    args: ["--no-sandbox"],
    // An install that would rather drive an already-present Chrome than the downloaded browser sets
    // one of these; left unset, playwright uses the co-located download named above.
    executablePath: process.env.JAKE_SIDECAR_EXECUTABLE_PATH,
    channel: process.env.JAKE_SIDECAR_CHANNEL,
  });
  const splitter = new LineSplitter();

  // Requests are handled strictly in order: each waits for the one before it to answer, because the
  // driver owns a single page and two concurrent navigations would fight over it. A malformed line is
  // skipped with nothing written back, since it carried no id to answer.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (line: string): void => {
    const parsed = parseRequestLine(line);
    if (!parsed.ok) {
      return;
    }
    const request = parsed.request;
    chain = chain.then(async () => {
      const response = await dispatch(request, driver);
      writeResponse(formatResponseLine(response));
    });
  };

  const shutdown = async (): Promise<void> => {
    try {
      await driver.close();
    } catch {
      // best effort on the way out
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  for await (const chunk of Bun.stdin.stream()) {
    for (const line of splitter.push(chunk)) {
      enqueue(line);
    }
  }
  // Standard input reached end — the agent closed the pipe. Finish the queued work, close the
  // browser, and exit rather than linger with a Chromium still open.
  await chain;
  await driver.close();
}

void main();
