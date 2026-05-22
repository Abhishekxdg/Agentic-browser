/**
 * Playwright vs Agent Browser Benchmark
 * 5 sites in parallel.
 * Playwright: one shared browser process, one isolated page per test.
 * Agent Browser: one isolated session per test (separate Chrome process each).
 * Both sides run concurrently per site.
 */

import { chromium } from "playwright";
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
    playwright: async (page) => (await page.title()) === "Example Domain",
    agentBrowser: (model) => model.page.title === "Example Domain",
  },
  {
    name: "HTTPBin Form",
    url: "https://httpbin.org/forms/post",
    playwright: async (page) => await page.locator("form").count() > 0,
    agentBrowser: (model) => model.forms.some((f) => f.fields.some((fld) => fld.name === "custname")),
  },
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    playwright: async (page) => await page.locator("#searchInput, input[name='search']").count() > 0,
    agentBrowser: (model) => model.search !== null || model.forms.some((f) => f.fields.some((fld) => /search/i.test(fld.name))),
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
    agentBrowser: (model) => model.search !== null || model.forms.some((f) => f.fields.some((fld) => fld.name.toLowerCase().includes("q"))),
  },
];

type Result = { site: string; tool: "playwright" | "agent-browser"; success: boolean; durationMs: number; error?: string };

function t<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const s = performance.now();
  return fn().then((v) => ({ value: v, durationMs: Math.round(performance.now() - s) }));
}

async function main() {
  const totalStart = Date.now();

  // One shared Playwright browser process (but each test gets its own page)
  const pwBrowser = await chromium.launch({ headless: true });

  // Run all sites in parallel — each site runs PW and AB concurrently
  const allResults = await Promise.all(
    SITES.map(async (site): Promise<Result[]> => {
      const [pwResult, abResult] = await Promise.all([
        // Playwright: own page, browser shared (process-level, not tab-level)
        t(async () => {
          const page = await pwBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
          try {
            await page.goto(site.url, { waitUntil: "networkidle", timeout: 20000 });
            return await site.playwright(page);
          } finally {
            await page.close().catch(() => {}); // close this test's page only
          }
        })
          .then(({ value, durationMs }) => ({ site: site.name, tool: "playwright" as const, success: value, durationMs }))
          .catch((err) => ({ site: site.name, tool: "playwright" as const, success: false, durationMs: 0, error: err.message as string })),

        // Agent Browser: own session = own Chrome process, no shared tab state
        t(async () => {
          const session = await createSession({ browser: { headless: true } });
          try {
            const nav = await executeAction(session, { type: "navigate", url: site.url }, { refresh: false });
            if (!nav.success) throw new Error(nav.error ?? "navigation failed");
            await executeAction(session, { type: "wait", condition: "network.idle", ms: 4000 });
            await new Promise((r) => setTimeout(r, 300));
            const model = await refreshPageModel(session, { mode: "fast" });
            return site.agentBrowser(model);
          } finally {
            await closeSession(session.id).catch(() => {});
          }
        })
          .then(({ value, durationMs }) => ({ site: site.name, tool: "agent-browser" as const, success: value, durationMs }))
          .catch((err) => ({ site: site.name, tool: "agent-browser" as const, success: false, durationMs: 0, error: err.message as string })),
      ]);

      return [pwResult, abResult];
    })
  );

  await pwBrowser.close();

  const results = allResults.flat();
  const totalMs = Date.now() - totalStart;

  // Print side-by-side
  console.log("\nSITE                           TOOL              PASS  MS");
  console.log("-".repeat(62));
  for (const r of results) {
    const pass = r.success ? "PASS" : "FAIL";
    console.log(`${r.site.padEnd(30)} ${r.tool.padEnd(17)} ${pass}  ${r.durationMs}ms${r.error ? ` — ${r.error.slice(0, 50)}` : ""}`);
  }

  // Summary
  const byTool = new Map<Result["tool"], Result[]>();
  for (const r of results) byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), r]);

  console.log("\nSUMMARY");
  for (const [tool, toolResults] of byTool) {
    const passed = toolResults.filter((r) => r.success).length;
    const avgMs = Math.round(toolResults.reduce((s, r) => s + r.durationMs, 0) / toolResults.length);
    console.log(`  ${tool}: ${passed}/${toolResults.length} passed, avg ${avgMs}ms`);
  }
  console.log(`\nTotal wall time: ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
