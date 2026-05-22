import { chromium } from "playwright";
import { join } from "path";
import { tmpdir } from "os";
import { createSession, closeSession, executeAction, refreshPageModel } from "../src/agent-browser/session-manager.ts";
import type { SemanticPage } from "../src/agent-browser/semantic-page.ts";

process.env.EXTENSION_DISABLED = "true";

type SiteCheck = {
  name: string;
  url: string;
  playwright: (page: import("playwright").Page) => Promise<boolean>;
  agentBrowser: (model: SemanticPage) => boolean;
};

const SITES: SiteCheck[] = [
  {
    name: "Example Domain",
    url: "https://example.com",
    playwright: async (page) => (await page.title()) === "Example Domain" && await page.getByRole("heading", { name: /example/i }).count() > 0,
    agentBrowser: (model) => model.page.title === "Example Domain" && model.content.some((block) => block.type === "heading" && /example/i.test(block.text)),
  },
  {
    name: "HTTPBin Form",
    url: "https://httpbin.org/forms/post",
    playwright: async (page) => await page.locator("form").count() > 0 && await page.locator('input[name="custname"]').count() > 0,
    agentBrowser: (model) => model.forms.some((form) => form.fields.some((field) => field.name === "custname")),
  },
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    playwright: async (page) => await page.locator("#searchInput, input[name='search']").count() > 0,
    agentBrowser: (model) => model.search !== null || model.forms.some((form) => form.fields.some((field) => /search/i.test(field.name) || /search/i.test(field.type))),
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    playwright: async (page) => await page.locator(".titleline a").count() > 0,
    agentBrowser: (model) => model.navigation.length > 0 || model.content.length > 0,
  },
  {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com",
    playwright: async (page) => await page.locator("input[name='q'], textarea[name='q']").count() > 0,
    agentBrowser: (model) => model.search !== null || model.forms.some((form) => form.fields.some((field) => field.name.toLowerCase().includes("q"))),
  },
];

type Result = {
  site: string;
  tool: "playwright" | "agent-browser";
  success: boolean;
  durationMs: number;
  error?: string;
};

async function time<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, durationMs: Math.round(performance.now() - start) };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPlaywright(site: SiteCheck): Promise<Result> {
  const { value, durationMs } = await time(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      await page.goto(site.url, { waitUntil: "load", timeout: 15000 });
      return await site.playwright(page);
    } finally {
      await browser.close();
    }
  });
  return { site: site.name, tool: "playwright", success: value, durationMs };
}

async function runAgentBrowser(site: SiteCheck, index: number): Promise<Result> {
  const { value, durationMs } = await time(async () => {
    const session = await createSession({
      browser: {
        headless: true,
        remoteDebuggingPort: 9400 + index,
        userDataDir: join(tmpdir(), `agent-browser-benchmark-${process.pid}-${index}`),
      },
    });
    try {
      const nav = await executeAction(session, { type: "navigate", url: site.url });
      if (!nav.success) throw new Error(nav.error ?? "navigation failed");
      const model = await refreshPageModel(session);
      return site.agentBrowser(model);
    } finally {
      await closeSession(session.id);
    }
  });
  return { site: site.name, tool: "agent-browser", success: value, durationMs };
}

async function main() {
  const results: Result[] = [];

  for (const [index, site] of SITES.entries()) {
    try {
      results.push(await withTimeout(runPlaywright(site), 25000, `${site.name} playwright`));
    } catch (err) {
      results.push({ site: site.name, tool: "playwright", success: false, durationMs: 0, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      results.push(await withTimeout(runAgentBrowser(site, index), 25000, `${site.name} agent-browser`));
    } catch (err) {
      results.push({ site: site.name, tool: "agent-browser", success: false, durationMs: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const result of results) {
    console.log(`${result.success ? "PASS" : "FAIL"}\t${result.tool}\t${result.site}\t${result.durationMs}ms${result.error ? `\t${result.error}` : ""}`);
  }

  const byTool = new Map<Result["tool"], Result[]>();
  for (const result of results) {
    byTool.set(result.tool, [...(byTool.get(result.tool) ?? []), result]);
  }

  console.log("\nSUMMARY");
  for (const [tool, toolResults] of byTool) {
    const passed = toolResults.filter((result) => result.success).length;
    const avgMs = Math.round(toolResults.reduce((sum, result) => sum + result.durationMs, 0) / toolResults.length);
    console.log(`${tool}: ${passed}/${toolResults.length} passed, avg ${avgMs}ms`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
