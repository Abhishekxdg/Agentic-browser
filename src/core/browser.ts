import { chromium, type Browser, type BrowserContext, type Page, type LaunchOptions } from "playwright";

export interface BrowserConfig {
  headless?: boolean;
  proxy?: string;
  userDataDir?: string;
  viewport?: { width: number; height: number };
  extraArgs?: string[];
}

export class StealthBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;

  constructor(config: BrowserConfig = {}) {
    this.config = {
      headless: true,
      viewport: { width: 1920, height: 1080 },
      ...config,
    };
  }

  async launch(): Promise<Page> {
    const args: string[] = [
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-site-isolation-trials",
      "--disable-infobars",
      "--window-position=0,0",
      "--window-size=1920,1080",
      "--start-maximized",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      ...(this.config.extraArgs ?? []),
    ];

    const launchOpts: LaunchOptions = {
      headless: this.config.headless ?? false,
      args,
    };

    if (this.config.proxy) {
      launchOpts.proxy = { server: this.config.proxy };
    }

    this.browser = await chromium.launch(launchOpts);

    const contextOpts: Parameters<Browser["newContext"]>[0] = {
      viewport: this.config.viewport,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.006 },
      permissions: ["geolocation"],
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Upgrade-Insecure-Requests": "1",
      },
    };

    if (this.config.userDataDir) {
      // Playwright doesn't support userDataDir directly in newContext,
      // but we can persist storage state
    }

    this.context = await this.browser.newContext(contextOpts);

    // Inject stealth scripts to hide automation
    await this.context.addInitScript(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });

      // Override chrome.runtime
      // @ts-expect-error
      window.chrome = { runtime: {} };

      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);

      // Hide plugins length
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });

      // Hide languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    this.page = await this.context.newPage();

    // Set realistic viewport and emulate human-like behavior
    await this.page.evaluate(() => {
      (window as unknown as Record<string, number>).outerWidth = window.innerWidth;
      (window as unknown as Record<string, number>).outerHeight = window.innerHeight;
    });

    return this.page;
  }

  async newPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser not launched. Call launch() first.");
    return await this.context.newPage();
  }

  async screenshot(fullPage = false): Promise<Uint8Array> {
    if (!this.page) throw new Error("No page available");
    return await this.page.screenshot({ fullPage, type: "png" });
  }

  async saveSession(path: string): Promise<void> {
    if (!this.context) throw new Error("No context available");
    await this.context.storageState({ path });
  }

  async loadSession(path: string): Promise<void> {
    if (!this.browser) throw new Error("Browser not launched");
    this.context = await this.browser.newContext({ storageState: path });
    this.page = await this.context.newPage();
  }

  /** Close just the current page (keep browser alive for reuse). */
  async closePage(): Promise<void> {
    await this.page?.close().catch(() => {});
    this.page = null;
  }

  /** Full shutdown — kills the browser process. */
  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  /** Ensure browser is running, reusing existing instance if possible. */
  async ensureLaunched(): Promise<void> {
    if (!this.browser || !this.browser.isConnected()) {
      // Full relaunch
      this.context = null;
      this.page = null;
      await this.launch();
    } else if (!this.context) {
      this.context = await this.browser.newContext({ viewport: this.config.viewport });
    }
  }

  /** Open a fresh page on the existing browser (faster than full relaunch). */
  async newPageFresh(): Promise<Page> {
    await this.ensureLaunched();
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    this.page = await this.context!.newPage();
    return this.page;
  }

  getPage(): Page {
    if (!this.page) throw new Error("No page available. Call launch() first.");
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error("No context available. Call launch() first.");
    return this.context;
  }
}
