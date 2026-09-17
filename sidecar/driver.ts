// The real browser driver: playwright-core driving one Chromium. This is the only file in the whole
// project that imports playwright — which is exactly why the browser capability lives out here in an
// uncompiled sidecar and not in the compiled agent. It owns one browser, one context, and one page,
// created lazily on the first call that needs a page and torn down by `close`. Its methods are the
// ones the line-protocol dispatch calls; the dispatch and framing are checked with a fake driver,
// and this driver is exercised against a live Chromium on any platform, since it is ordinary Bun.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import type { BrowserDriver, FetchParams, NavigateParams, WaitUntil } from "./rpc";

/** How to launch Chromium. All optional: an install points playwright at its co-located browser, a
 *  test points it at a system Chrome or a cached build. When none is given, playwright's own lookup
 *  applies. */
export interface DriverLaunchOptions {
  /** An explicit path to the browser executable, bypassing playwright's version-pinned lookup. */
  executablePath?: string;
  /** A named channel such as "chrome" to use an installed Google Chrome instead of a download. */
  channel?: string;
  /** Extra flags for the browser process — headless containers often need --no-sandbox. */
  args?: string[];
  /** Whether to run headless. Defaults to true; the sidecar has no display to show a window on. */
  headless?: boolean;
}

/**
 * The playwright-backed driver. Every method ensures a page exists first — `page()` launches the
 * browser and opens a blank page on first use — so `eval` or `shot` work even before a navigate. The
 * browser launch is where a missing download surfaces: playwright throws with its own "run install"
 * guidance, which the dispatch turns into a driver-error the agent relays intact.
 */
export class PlaywrightDriver implements BrowserDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;

  constructor(private readonly launch: DriverLaunchOptions = {}) {}

  private async page(): Promise<Page> {
    if (this.currentPage !== null && !this.currentPage.isClosed()) {
      return this.currentPage;
    }
    if (this.browser === null) {
      this.browser = await chromium.launch({
        headless: this.launch.headless ?? true,
        executablePath: this.launch.executablePath,
        channel: this.launch.channel,
        args: this.launch.args,
      });
    }
    if (this.context === null) {
      this.context = await this.browser.newContext();
    }
    this.currentPage = await this.context.newPage();
    return this.currentPage;
  }

  async navigate(params: NavigateParams): Promise<{ url: string; status: number | null }> {
    const page = await this.page();
    const response = await page.goto(params.url, {
      waitUntil: params.waitUntil satisfies WaitUntil,
      timeout: params.timeoutMs,
    });
    return { url: page.url(), status: response === null ? null : response.status() };
  }

  async source(): Promise<{ url: string; html: string }> {
    const page = await this.page();
    return { url: page.url(), html: await page.content() };
  }

  async shot(params: { fullPage: boolean }): Promise<{ png: Uint8Array }> {
    const page = await this.page();
    // Chromium intermittently answers the very first capture after a navigation with a transient
    // "Unable to capture screenshot" protocol error while the compositor settles. It clears on a
    // retry, so a capture is attempted a few times with a short pause before the failure is surfaced.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const buffer = await page.screenshot({ type: "png", fullPage: params.fullPage });
        return { png: new Uint8Array(buffer) };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError;
  }

  async evaluate(params: { expression: string }): Promise<{ value: unknown }> {
    const page = await this.page();
    // Evaluate the expression as a function body in the page, so a bare expression such as
    // "document.title" or an IIFE both work. The returned value must be JSON-serialisable, which
    // playwright enforces; a non-serialisable result throws and is reported as a driver-error.
    const value = (await page.evaluate(`(() => (${params.expression}))()`)) as unknown;
    return { value };
  }

  async fetch(params: FetchParams): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    const page = await this.page();
    // The fetch runs inside the page, so the page's origin, cookies, and session apply — this is the
    // point of a page-context fetch over the agent's own top-level fetch. The body is read as text and
    // capped, so a large response is truncated rather than pulled whole across the line protocol.
    const result = (await page.evaluate(
      async ([url, method, headersJson, body, maxBytes]) => {
        const headers = JSON.parse(headersJson as string) as Record<string, string>;
        const init: RequestInit = { method: method as string, headers };
        if (body !== null && method !== "GET" && method !== "HEAD") {
          init.body = body as string;
        }
        const response = await fetch(url as string, init);
        const text = await response.text();
        const cap = maxBytes as number;
        const truncated = text.length > cap;
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((value: string, key: string) => {
          outHeaders[key] = value;
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: outHeaders,
          body: truncated ? text.slice(0, cap) : text,
          bytes: text.length,
          truncated,
        };
      },
      [params.url, params.method, JSON.stringify(params.headers), params.body, params.maxBytes] as const,
    )) as { status: number; statusText: string; headers: Record<string, string>; body: string; bytes: number; truncated: boolean };
    return result;
  }

  async close(): Promise<void> {
    // Close the page, the context, then the browser, tolerating any already gone; a half-open browser
    // must not leave a Chromium behind on 하스's machine.
    try {
      await this.currentPage?.close();
    } catch {
      // already closed
    }
    try {
      await this.context?.close();
    } catch {
      // already closed
    }
    try {
      await this.browser?.close();
    } catch {
      // already closed
    }
    this.currentPage = null;
    this.context = null;
    this.browser = null;
  }
}
