/**
 * CDP Browser Bridge
 * Direct Chrome DevTools Protocol client using Bun's native fetch + WebSocket.
 * No Playwright abstraction — full control, lower latency.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve, join } from "path";
import { homedir, tmpdir } from "os";
import { existsSync } from "fs";
import type { WebSocket } from "ws";

import { chromium as _pwChromium } from "playwright";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? _pwChromium.executablePath();

// Auto-detect extension directory: EXTENSION_PATH env > ./extension > /app/extension (Docker)
function resolveExtensionPath(): string | null {
  if (process.env.EXTENSION_PATH) return process.env.EXTENSION_PATH;
  if (process.env.EXTENSION_DISABLED === "true") return null;
  // Candidates: relative to this file, relative to cwd, Docker path
  const candidates = [
    resolve(import.meta.dir, "../../extension"),
    resolve(process.cwd(), "extension"),
    "/app/extension",
  ];
  for (const p of candidates) {
    if (existsSync(p + "/manifest.json")) return p;
  }
  return null; // extension not found — launch without it
}

interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CDPEvent {
  method: string;
  params?: unknown;
}

export interface CDPBrowserConfig {
  headless?: boolean;
  remoteDebuggingPort?: number;
  userDataDir?: string;
  proxy?: string;
  extraArgs?: string[];
  attachToRunning?: boolean; // connect to existing Chrome on port, don't spawn
  loadExtension?: string;   // absolute path to extension folder — loads it into Chrome
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export class CDPBridge {
  private ws: WebSocket | null = null;
  private chromeProcess: ChildProcess | null = null;
  private messageId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: unknown) => void>>();
  private config: CDPBrowserConfig;
  private remoteDebuggingPort: number;
  activeTabId: string | null = null;

  constructor(config: CDPBrowserConfig = {}) {
    this.config = {
      headless: true,
      remoteDebuggingPort: 9222,
      ...config,
    };
    this.remoteDebuggingPort = this.config.remoteDebuggingPort ?? 9222;
  }

  /** Launch Chromium with remote debugging and connect via CDP */
  async launch(): Promise<void> {
    if (this.chromeProcess) {
      return;
    }

    // If attachToRunning, skip spawn — just connect to existing Chrome on the port
    if (this.config.attachToRunning) {
      await this.connectToTarget();
      return;
    }

    const args = [
      `--remote-debugging-port=${this.remoteDebuggingPort}`,
      `--no-first-run`,
      `--no-default-browser-check`,
      `--disable-infobars`,
      `--disable-blink-features=AutomationControlled`,
      `--disable-features=IsolateOrigins,site-per-process,AutomationControlled`,
      `--disable-site-isolation-trials`,
      `--disable-background-networking`,
      `--disable-background-timer-throttling`,
      `--disable-backgrounding-occluded-windows`,
      `--disable-renderer-backgrounding`,
      `--disable-breakpad`,
      `--disable-component-update`,
      `--disable-default-apps`,
      `--disable-extensions`,
      `--disable-hang-monitor`,
      `--disable-ipc-flooding-protection`,
      `--disable-popup-blocking`,
      `--disable-prompt-on-repost`,
      `--disable-sync`,
      `--disable-translate`,
      `--force-color-profile=srgb`,
      `--metrics-recording-only`,
      `--password-store=basic`,
      `--use-mock-keychain`,
      `--window-position=0,0`,
      `--window-size=1920,1080`,
      `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-software-rasterizer",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      ...(this.config.headless ? ["--headless=new"] : []),
      ...(this.config.proxy ? [`--proxy-server=${this.config.proxy}`] : []),
      ...((() => {
        const extPath = this.config.loadExtension ?? resolveExtensionPath();
        if (extPath) {
          // Extensions need a persistent user data dir (not temp) to load properly
          const udd = this.config.userDataDir ?? join(homedir(), ".agent-browser", "chrome-profile");
          return [
            `--user-data-dir=${udd}`,
            `--load-extension=${extPath}`,
            `--disable-extensions-except=${extPath}`,
          ];
        }
        return [this.config.userDataDir ? `--user-data-dir=${this.config.userDataDir}` : `--user-data-dir=${join(tmpdir(), "agent-browser-" + Date.now())}`];
      })()),
      ...(this.config.extraArgs ?? []),
      ...(process.env.CHROME_FLAGS ? process.env.CHROME_FLAGS.split(" ").filter(Boolean) : []),
    ];

    this.chromeProcess = spawn(CHROMIUM_PATH, args, {
      detached: false,
      stdio: "ignore",
    });

    // Wait for Chrome to be ready (poll /json/version)
    const maxWait = 15000;
    const start = Date.now();
    let ready = false;

    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(`http://localhost:${this.remoteDebuggingPort}/json/version`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // Chrome not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!ready) {
      await this.kill();
      throw new Error(`Chromium failed to start. Run: bunx playwright install chromium\n  Path tried: ${CHROMIUM_PATH}`);
    }

    // Connect to the first available page/target
    await this.connectToTarget();
  }

  /** Connect WebSocket to a specific CDP page target (or first available) */
  private async connectToTarget(targetId?: string): Promise<void> {
    const listRes = await fetch(`http://localhost:${this.remoteDebuggingPort}/json/list`);
    const targets = (await listRes.json()) as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>;

    const pageTargets = targets.filter((t) => t.type === "page");
    const target = targetId
      ? pageTargets.find((t) => t.id === targetId)
      : (pageTargets[0] ?? targets[0]);

    if (!target) {
      throw new Error(targetId ? `Tab ${targetId} not found` : "No CDP target found");
    }

    // Close existing WS without clearing pending (caller handles state)
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const WebSocketCtor = (await import("ws")).default;
    this.ws = new WebSocketCtor(target.webSocketDebuggerUrl) as WebSocket;

    await new Promise<void>((resolve, reject) => {
      this.ws!.on("open", resolve);
      this.ws!.on("error", reject);
      // Bun ws types differ from @types/ws, use any for safety
      (this.ws as any).on("message", (raw: Buffer | ArrayBuffer | string) => {
        const text = typeof raw === "string" ? raw : raw instanceof Buffer ? raw.toString("utf-8") : Buffer.from(new Uint8Array(raw)).toString("utf-8");
        this.handleMessage(text);
      });
    });

    this.activeTabId = target.id;

    // Enable essential CDP domains
    await this.send("Page.enable");
    await this.send("DOM.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");

    // Inject comprehensive stealth scripts
    await this.injectStealthScripts();
  }

  /** Click at absolute page coordinates */
  async clickAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** Reconnect WebSocket to Chrome without relaunching (use after WS drop) */
  async reconnect(targetId?: string): Promise<void> {
    await this.connectToTarget(targetId ?? this.activeTabId ?? undefined);
  }

  /** List all open tabs */
  async listTabs(): Promise<TabInfo[]> {
    const res = await fetch(`http://localhost:${this.remoteDebuggingPort}/json/list`);
    const targets = (await res.json()) as Array<{ id: string; type: string; url: string; title: string }>;
    return targets
      .filter((t) => t.type === "page")
      .map((t) => ({ id: t.id, url: t.url, title: t.title ?? "", active: t.id === this.activeTabId }));
  }

  /** Open a new tab, optionally navigating to url. Returns new tab's id. */
  async openTab(url?: string): Promise<string> {
    const endpoint = url
      ? `http://localhost:${this.remoteDebuggingPort}/json/new?${encodeURIComponent(url)}`
      : `http://localhost:${this.remoteDebuggingPort}/json/new`;
    const res = await fetch(endpoint, { method: "PUT" });
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    if (!target.id) throw new Error("Failed to create new tab");
    // Switch to the new tab
    await this.switchTab(target.id);
    return target.id;
  }

  /** Switch active CDP connection to a different tab */
  async switchTab(targetId: string): Promise<void> {
    if (targetId === this.activeTabId) return;
    // Reject any in-flight pending commands on old connection
    for (const [id, { reject }] of this.pending) {
      reject(new Error("Tab switched — command cancelled"));
      this.pending.delete(id);
    }
    // Clear event handlers from old tab context
    this.eventHandlers.clear();
    await this.connectToTarget(targetId);
  }

  /** Close a tab by id. Switches to first remaining tab if active tab was closed. */
  async closeTab(targetId: string): Promise<void> {
    const wasActive = targetId === this.activeTabId;
    await fetch(`http://localhost:${this.remoteDebuggingPort}/json/close/${targetId}`);
    if (wasActive) {
      // Small delay for Chrome to remove target
      await new Promise((r) => setTimeout(r, 200));
      const remaining = await this.listTabs();
      if (remaining.length > 0) {
        await this.switchTab(remaining[0]!.id);
      } else {
        this.ws?.close();
        this.ws = null;
        this.activeTabId = null;
      }
    }
  }

  /** Inject stealth scripts after page connection */
  private async injectStealthScripts(): Promise<void> {
    await this.send("Network.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      acceptLanguage: "en-US,en;q=0.9",
      platform: "MacIntel",
    });

    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: this.buildStealthScript(),
    });

    // Also run on current page immediately
    await this.evaluate(this.buildStealthScript(), false);
  }

  private buildStealthScript(): string {
    return `
(function() {
  // Remove CDP-injected variables that sites detect
  const cdpVars = Object.keys(window).filter(k => k.startsWith('cdc_') || k.includes('__puppeteer'));
  for (const v of cdpVars) {
    try { delete window[v]; } catch {}
  }

  // Override navigator.webdriver
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch {}

  // Realistic chrome.runtime
  window.chrome = {
    runtime: {
      OnInstalledReason: { CHROME_UPDATE: "chrome_update", UPDATE: "update", INSTALL: "install" },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", MIPS64el: "mips64el", MIPSel: "mipsel", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
      RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
    },
  };

  // Realistic plugins
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "Portable Document Format" },
        { name: "Native Client", filename: "internal-nacl-plugin", description: "Native Client" },
      ],
    });
  } catch {}

  // Realistic mimeTypes
  try {
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => [
        { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: { name: "Chrome PDF Plugin" } },
        { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: { name: "Chrome PDF Viewer" } },
        { type: "application/x-nacl", suffixes: "", description: "Native Client", enabledPlugin: { name: "Native Client" } },
      ],
    });
  } catch {}

  // Override permissions
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === "notifications"
      ? Promise.resolve({ state: Notification.permission, onchange: null, addEventListener: () => {}, removeEventListener: () => {} })
      : origQuery(parameters);

  // Canvas fingerprint randomization (subtle noise)
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const result = origGetImageData.apply(this, args);
    if (result && result.data) {
      for (let i = 0; i < result.data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 0.5;
        result.data[i] = Math.min(255, Math.max(0, result.data[i] + noise));
      }
    }
    return result;
  };

  // WebGL fingerprint randomization
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return "Intel Inc.";
    if (parameter === 37446) return "Intel Iris Xe Graphics";
    return origGetParameter.call(this, parameter);
  };

  // Set outer dimensions to match inner
  Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
  Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
  Object.defineProperty(window, 'devicePixelRatio', { get: () => 2 });

  // Hide automation from iframes too
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(...args) {
      const shadow = origAttachShadow.apply(this, args);
      return shadow;
    };
  } catch {}

  // Override toString on patched functions to hide tampering
  function makeNative(fn, str) {
    Object.defineProperty(fn, 'toString', { value: () => str, writable: false });
    Object.defineProperty(fn, 'name', { value: str.match(/\\[object\\s(\\w+)\\]/)?.[1] || 'Function', writable: false });
  }
  makeNative(navigator.permissions.query, "function query() { [native code] }");
  makeNative(CanvasRenderingContext2D.prototype.getImageData, "function getImageData() { [native code] }");
  makeNative(WebGLRenderingContext.prototype.getParameter, "function getParameter() { [native code] }");
})();
    `.trim();
  }

  /** Send a CDP command and wait for response */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("CDP WebSocket not connected");
    }

    const id = ++this.messageId;
    const message = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(message);
    });
  }

  /** Evaluate JavaScript in the page context */
  async evaluate(expression: string, returnByValue = true): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise: true,
    }) as { result?: { value?: unknown; type?: string }; exceptionDetails?: unknown };

    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result.result?.value;
  }

  /** Navigate to a URL */
  async navigate(url: string): Promise<{ frameId: string }> {
    const result = await this.send("Page.navigate", { url }) as { frameId: string };
    // Wait for load event
    await this.waitForEvent("Page.loadEventFired", 15000);
    return result;
  }

  /** Wait for a specific CDP event */
  async waitForEvent(eventName: string, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(eventName, handler);
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeoutMs);

      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.off(eventName, handler);
        resolve(params);
      };

      this.on(eventName, handler);
    });
  }

  /** Register an event handler */
  on(eventName: string, handler: (params: unknown) => void): void {
    const handlers = this.eventHandlers.get(eventName) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(eventName, handlers);
  }

  /** Remove an event handler */
  off(eventName: string, handler: (params: unknown) => void): void {
    const handlers = this.eventHandlers.get(eventName);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
    if (handlers.length === 0) this.eventHandlers.delete(eventName);
  }

  /** Handle incoming CDP messages */
  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as CDPResponse | CDPEvent;

      if ("id" in msg && msg.id !== undefined) {
        // Response to a command
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if ("method" in msg && msg.method) {
        // Event notification
        const handlers = this.eventHandlers.get(msg.method) ?? [];
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch {
            // Swallow handler errors
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  /** Get current page URL */
  async getUrl(): Promise<string> {
    const result = await this.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    }) as { result?: { value: string } };
    return result.result?.value ?? "";
  }

  /** Get page title */
  async getTitle(): Promise<string> {
    const result = await this.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    }) as { result?: { value: string } };
    return result.result?.value ?? "";
  }

  /** Get document root node ID for DOM traversal */
  async getDocument(): Promise<{ root: { nodeId: number } }> {
    return await this.send("DOM.getDocument", { depth: -1, pierce: true }) as { root: { nodeId: number } };
  }

  /** Query a selector and return node IDs */
  async querySelector(nodeId: number, selector: string): Promise<{ nodeId: number }> {
    return await this.send("DOM.querySelector", { nodeId, selector }) as { nodeId: number };
  }

  /** Get node attributes */
  async getAttributes(nodeId: number): Promise<{ attributes: string[] }> {
    return await this.send("DOM.getAttributes", { nodeId }) as { attributes: string[] };
  }

  /** Focus an element by nodeId */
  async focusElement(nodeId: number): Promise<void> {
    await this.send("DOM.focus", { nodeId });
  }

  /** Set input value by nodeId — React-compatible via native value setter */
  async setInputValue(nodeId: number, value: string): Promise<void> {
    // Get element attributes to build a reliable selector
    const attrsResult = await this.send("DOM.getAttributes", { nodeId }) as { attributes: string[] };
    const attrs: Record<string, string> = {};
    for (let i = 0; i < attrsResult.attributes.length; i += 2) {
      attrs[attrsResult.attributes[i]!] = attrsResult.attributes[i + 1] ?? "";
    }

    // Build selectors using attribute selectors (no CSS.escape needed)
    const selectors: string[] = [];
    if (attrs.id) selectors.push(`[id=${JSON.stringify(attrs.id)}]`);
    if (attrs.name) selectors.push(`[name=${JSON.stringify(attrs.name)}]`);
    if (attrs.placeholder) selectors.push(`[placeholder=${JSON.stringify(attrs.placeholder)}]`);
    if (attrs.type) selectors.push(`input[type=${JSON.stringify(attrs.type)}]`);
    selectors.push("input, textarea, select");

    await this.evaluate(`
      (function() {
        const selectors = ${JSON.stringify(selectors)};
        let el = null;
        for (const s of selectors) {
          try { el = document.querySelector(s); if (el) break; } catch {}
        }
        if (!el) return;
        // React-compatible: use native setter so React state updates
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype :
          el.tagName === 'SELECT'   ? window.HTMLSelectElement.prototype :
                                      window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, ${JSON.stringify(value)});
        } else {
          el.value = ${JSON.stringify(value)};
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true }));
      })()
    `);
  }

  /** Click an element by nodeId (fallback to coordinate click if needed) */
  async clickElement(nodeId: number): Promise<void> {
    // Get the bounding box for the node
    const boxResult = await this.send("DOM.getBoxModel", { nodeId }) as {
      model?: { content: number[] };
    };

    if (boxResult.model?.content) {
      const coords = boxResult.model.content;
      const x = (coords[0]! + coords[2]! + coords[4]! + coords[6]!) / 4;
      const y = (coords[1]! + coords[3]! + coords[5]! + coords[7]!) / 4;

      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } else {
      // Fallback: dispatch click event
      await this.evaluate(`
        (function() {
          const node = document.querySelector('[data-cdp-nodeid="${nodeId}"]') || document;
          const el = node.querySelector ? node.querySelector('*') : node;
          if (el && el.click) el.click();
        })()
      `);
    }
  }

  /** Type text into a focused element */
  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
      });
    }
  }

  /** Press a key (Enter, Tab, Escape, etc.) */
  async pressKey(key: string): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
    });
  }

  /** Scroll the page */
  async scroll(direction: "up" | "down" | "top" | "bottom", amount?: number): Promise<void> {
    const scrollAmount = amount ?? (direction === "up" || direction === "down" ? window.innerHeight * 0.8 : 0);
    const script =
      direction === "top"
        ? "window.scrollTo(0, 0)"
        : direction === "bottom"
        ? "window.scrollTo(0, document.body.scrollHeight)"
        : direction === "up"
        ? `window.scrollBy(0, -${scrollAmount})`
        : `window.scrollBy(0, ${scrollAmount})`;
    await this.evaluate(script);
  }

  /** Select an option in a <select> element */
  async selectOption(nodeId: number, value: string): Promise<void> {
    await this.evaluate(`
      (function() {
        const el = document.querySelector('[data-cdp-nodeid="${nodeId}"]') || document;
        const select = el.tagName === 'SELECT' ? el : el.querySelector('select');
        if (select) {
          select.value = "${value.replace(/"/g, '\\"')}";
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()
    `);
  }

  /** Take a screenshot and return base64 PNG */
  async screenshot(fullPage = false): Promise<string> {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    }) as { data: string };
    return result.data;
  }

  /** Mouse hover over an element by nodeId */
  async hoverElement(nodeId: number): Promise<void> {
    const boxResult = await this.send("DOM.getBoxModel", { nodeId }) as { model?: { content: number[] } };
    if (!boxResult.model?.content) throw new Error("Cannot get bounding box for hover");
    const coords = boxResult.model.content;
    const x = (coords[0]! + coords[2]! + coords[4]! + coords[6]!) / 4;
    const y = (coords[1]! + coords[3]! + coords[5]! + coords[7]!) / 4;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  /** Double-click an element by nodeId */
  async doubleClickElement(nodeId: number): Promise<void> {
    const boxResult = await this.send("DOM.getBoxModel", { nodeId }) as { model?: { content: number[] } };
    if (!boxResult.model?.content) throw new Error("Cannot get bounding box for double-click");
    const coords = boxResult.model.content;
    const x = (coords[0]! + coords[2]! + coords[4]! + coords[6]!) / 4;
    const y = (coords[1]! + coords[3]! + coords[5]! + coords[7]!) / 4;
    for (const clickCount of [1, 2]) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
    }
  }

  /** Right-click an element by nodeId */
  async rightClickElement(nodeId: number): Promise<void> {
    const boxResult = await this.send("DOM.getBoxModel", { nodeId }) as { model?: { content: number[] } };
    if (!boxResult.model?.content) throw new Error("Cannot get bounding box for right-click");
    const coords = boxResult.model.content;
    const x = (coords[0]! + coords[2]! + coords[4]! + coords[6]!) / 4;
    const y = (coords[1]! + coords[3]! + coords[5]! + coords[7]!) / 4;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
  }

  /** Navigate history: back, forward, or refresh */
  async history(direction: "back" | "forward" | "refresh"): Promise<void> {
    if (direction === "refresh") {
      await this.send("Page.reload", { ignoreCache: false });
      await this.waitForEvent("Page.loadEventFired", 15000);
      return;
    }
    const nav = await this.send("Page.getNavigationHistory") as { currentIndex: number; entries: Array<{ id: number }> };
    const target = direction === "back"
      ? nav.entries[nav.currentIndex - 1]
      : nav.entries[nav.currentIndex + 1];
    if (!target) throw new Error(`Cannot go ${direction}: no history entry`);
    await this.send("Page.navigateToHistoryEntry", { entryId: target.id });
    await this.waitForEvent("Page.loadEventFired", 15000);
  }

  /** Get all cookies (optionally filtered by url) */
  async getCookies(url?: string): Promise<Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string; expires?: number }>> {
    const params = url ? { urls: [url] } : {};
    const result = await this.send("Network.getCookies", params) as { cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite?: string; expires?: number }> };
    return result.cookies;
  }

  /** Set a cookie */
  async setCookie(cookie: { name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number }): Promise<void> {
    await this.send("Network.setCookie", cookie);
  }

  /** Clear all cookies */
  async clearCookies(): Promise<void> {
    await this.send("Network.clearBrowserCookies");
  }

  /** Handle a JS dialog (alert/confirm/prompt). Call before or after dialog fires. */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.send("Page.handleJavaScriptDialog", { accept, promptText: promptText ?? "" });
  }

  /** Enable dialog auto-handling so automation doesn't block on alerts */
  async enableDialogAutoHandle(accept = true): Promise<void> {
    this.on("Page.javascriptDialogOpening", async () => {
      try { await this.handleDialog(accept); } catch { /* already dismissed */ }
    });
  }

  /** Upload files to a file input by nodeId */
  async uploadFile(nodeId: number, filePaths: string[]): Promise<void> {
    await this.send("DOM.setFileInputFiles", { nodeId, files: filePaths });
  }

  /** Wait for a selector to appear in DOM. Returns nodeId or null on timeout. */
  async waitForSelector(selector: string, timeoutMs = 10000): Promise<number | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const doc = await this.getDocument();
        const node = await this.querySelector(doc.root.nodeId, selector);
        if (node?.nodeId) return node.nodeId;
      } catch { /* not found yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  /** Press a keyboard shortcut with modifiers (e.g. Ctrl+A, Ctrl+C) */
  async keyboardShortcut(modifiers: Array<"Alt" | "Ctrl" | "Meta" | "Shift">, key: string): Promise<void> {
    const modifierBits: Record<string, number> = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
    const modifiersMask = modifiers.reduce((acc, m) => acc | (modifierBits[m] ?? 0), 0);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: modifiersMask, key });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: modifiersMask, key });
  }

  /** Get all localStorage entries from the current page */
  async getLocalStorage(): Promise<Record<string, string>> {
    return await this.evaluate(`
      (function() {
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) result[k] = localStorage.getItem(k) || '';
        }
        return result;
      })()
    `) as Record<string, string>;
  }

  /** Set a localStorage entry */
  async setLocalStorage(key: string, value: string): Promise<void> {
    await this.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }

  /** Get all sessionStorage entries */
  async getSessionStorage(): Promise<Record<string, string>> {
    return await this.evaluate(`
      (function() {
        const result = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k) result[k] = sessionStorage.getItem(k) || '';
        }
        return result;
      })()
    `) as Record<string, string>;
  }

  /** Set a sessionStorage entry */
  async setSessionStorage(key: string, value: string): Promise<void> {
    await this.evaluate(`sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }

  /** Drag from one nodeId to another */
  async dragDrop(fromNodeId: number, toNodeId: number): Promise<void> {
    const fromBox = await this.send("DOM.getBoxModel", { nodeId: fromNodeId }) as { model?: { content: number[] } };
    const toBox = await this.send("DOM.getBoxModel", { nodeId: toNodeId }) as { model?: { content: number[] } };
    if (!fromBox.model?.content || !toBox.model?.content) throw new Error("Cannot get bounding boxes for drag-drop");

    const fc = fromBox.model.content;
    const tc = toBox.model.content;
    const fx = (fc[0]! + fc[2]! + fc[4]! + fc[6]!) / 4;
    const fy = (fc[1]! + fc[3]! + fc[5]! + fc[7]!) / 4;
    const tx = (tc[0]! + tc[2]! + tc[4]! + tc[6]!) / 4;
    const ty = (tc[1]! + tc[3]! + tc[5]! + tc[7]!) / 4;

    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", clickCount: 1 });
    // Move in steps for realistic drag
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const ix = fx + (tx - fx) * (i / steps);
      const iy = fy + (ty - fy) * (i / steps);
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "left" });
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tx, y: ty, button: "left", clickCount: 1 });
  }

  /** Get visible text of a DOM element matching selector */
  async getElementText(selector: string): Promise<string | null> {
    return await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? (el.textContent || el.innerText || '').trim() : null;
      })()
    `) as string | null;
  }

  /** Get all iframe src URLs + their document content (for email viewers etc.) */
  async getIframeContents(): Promise<Array<{ src: string; html: string }>> {
    return await this.evaluate(`
      (function() {
        return Array.from(document.querySelectorAll('iframe')).map(iframe => {
          try {
            const src = iframe.src || '';
            const html = iframe.contentDocument ? iframe.contentDocument.documentElement.outerHTML : '';
            return { src, html };
          } catch { return { src: iframe.src || '', html: '' }; }
        });
      })()
    `) as Array<{ src: string; html: string }>;
  }

  /** Kill the Chrome process and close the WebSocket */
  async kill(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.chromeProcess) {
      this.chromeProcess.kill("SIGTERM");
      // Give it a moment, then SIGKILL
      await new Promise((r) => setTimeout(r, 500));
      if (!this.chromeProcess.killed) {
        this.chromeProcess.kill("SIGKILL");
      }
      this.chromeProcess = null;
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }
  // ── Human-like behavior ────────────────────────────────────────────────

  /** Type text with human-like variable speed (30-120ms per char, occasional pauses) */
  async humanType(text: string): Promise<void> {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
      await this.send("Input.dispatchKeyEvent", { type: "char", text: char });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
      // Variable delay: 30-100ms per char, occasional 200-500ms "thinking" pause
      const delay = Math.random() < 0.05
        ? 200 + Math.random() * 300  // occasional long pause
        : 30 + Math.random() * 70;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Move mouse along a bezier curve path (human-like, not instant jump) */
  async humanMove(toX: number, toY: number, fromX?: number, fromY?: number): Promise<void> {
    const startX = fromX ?? 760;
    const startY = fromY ?? 400;
    const steps = 8 + Math.floor(Math.random() * 8);
    // Control points for bezier curve
    const cp1x = startX + (toX - startX) * 0.3 + (Math.random() - 0.5) * 80;
    const cp1y = startY + (toY - startY) * 0.3 + (Math.random() - 0.5) * 80;
    const cp2x = startX + (toX - startX) * 0.7 + (Math.random() - 0.5) * 80;
    const cp2y = startY + (toY - startY) * 0.7 + (Math.random() - 0.5) * 80;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const x = mt*mt*mt*startX + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*toX;
      const y = mt*mt*mt*startY + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*toY;
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 12));
    }
  }

  /** Click with human-like movement and timing */
  async humanClick(x: number, y: number): Promise<void> {
    await this.humanMove(x, y);
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 50)); // hover pause
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 80)); // press duration
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** Random micro-scroll (humans scroll randomly while reading) */
  async humanScroll(direction: "down" | "up" = "down"): Promise<void> {
    const delta = direction === "down" ? 100 + Math.random() * 200 : -(100 + Math.random() * 200);
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 760, y: 400, deltaX: 0, deltaY: delta });
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
  }

  // ── Iframe execution context ───────────────────────────────────────────

  /** Evaluate JS in a specific iframe by its src URL */
  async evaluateInIframe(iframeSrcPattern: string, expression: string): Promise<unknown> {
    // Get all execution contexts
    const frames = await this.evaluate(`
      Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: f.src, id: f.id, name: f.name
      }))
    `) as Array<{ src: string; id: string; name: string }>;

    const target = frames.find((f) => f.src.includes(iframeSrcPattern) || f.id === iframeSrcPattern || f.name === iframeSrcPattern);
    if (!target) throw new Error(`Iframe not found: ${iframeSrcPattern}`);

    // Execute within the iframe's document
    return this.evaluate(`
      (function() {
        const iframe = Array.from(document.querySelectorAll('iframe'))
          .find(f => f.src.includes(${JSON.stringify(iframeSrcPattern)}) || f.id === ${JSON.stringify(iframeSrcPattern)});
        if (!iframe || !iframe.contentDocument) throw new Error('iframe not accessible');
        const doc = iframe.contentDocument;
        return (function(document, window) { return ${expression}; })(doc, iframe.contentWindow);
      })()
    `);
  }

  /** Fill an input inside an iframe */
  async fillInIframe(iframeSrc: string, selector: string, value: string): Promise<void> {
    await this.evaluate(`
      (function() {
        const iframe = Array.from(document.querySelectorAll('iframe'))
          .find(f => f.src.includes(${JSON.stringify(iframeSrc)}) || f.id === ${JSON.stringify(iframeSrc)} || f.name === ${JSON.stringify(iframeSrc)});
        if (!iframe?.contentDocument) throw new Error('iframe not accessible: ' + ${JSON.stringify(iframeSrc)});
        const el = iframe.contentDocument.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('element not found in iframe: ' + ${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      })()
    `);
  }

  /** Click an element inside an iframe */
  async clickInIframe(iframeSrc: string, selector: string): Promise<void> {
    await this.evaluate(`
      (function() {
        const iframe = Array.from(document.querySelectorAll('iframe'))
          .find(f => f.src.includes(${JSON.stringify(iframeSrc)}) || f.id === ${JSON.stringify(iframeSrc)} || f.name === ${JSON.stringify(iframeSrc)});
        if (!iframe?.contentDocument) throw new Error('iframe not accessible');
        const el = iframe.contentDocument.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('element not found in iframe: ' + ${JSON.stringify(selector)});
        el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true}));
        if (el.click) el.click();
      })()
    `);
  }


}
