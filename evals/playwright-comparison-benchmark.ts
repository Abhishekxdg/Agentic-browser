/**
 * Playwright vs Agent Browser Benchmark
 * Side-by-side comparison on 5 sites.
 *
 * Optimizations:
 * - Both tools run in parallel per site (not sequentially)
 * - Agent browser: one pre-warmed session shared, not one per site
 * - network.idle replaces fixed sleep
 * - Playwright: one browser shared across all tests
 */

import { chromium } from "playwright";
import { createSession, closeSession, executeAction, refreshPageModel, getSession } from "../src/agent-browser/session-manager.ts";
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

function time<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const start = performance.now();
  return fn().then((value) => ({ value, durationMs: Math.round(performance.now() - start) }));
}

async function main() {
  const totalStart = Date.now();

  // Pre-warm both tools in parallel
  console.log("[setup] launching Playwright + Agent Browser...");
  const [pwBrowser, abSession] = await Promise.all([
    chromium.launch({ headless: true }),
    createSession({ browser: { headless: true } }),
  ]);
  console.log(`[setup] ready in ${Date.now() - totalStart}ms\n`);

  // Run all sites in parallel, each running Playwright + Agent Browser simultaneously
  const allResults = await Promise.all(
    SITES.map(async (site): Promise<Result[]> => {
      const [pwResult, abResult] = await Promise.all([
        // Playwright: new page per site (reuse browser)
        time(async () => {
          const page = await pwBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
          try {
            await page.goto(site.url, { waitUntil: "networkidle", timeout: 15000 });
            return site.playwright(page);
          } finally { await page.close(); }
        }).then(({ value, durationMs }) => ({ site: site.name, tool: "playwright" as const, success: value, durationMs }))
          .catch((err) => ({ site: site.name, tool: "playwright" as const, success: false, durationMs: 0, error: err.message })),

        // Agent Browser: reuse pre-warmed session
        time(async () => {
          const session = getSession(abSession.id)!;
          const nav = await executeAction(session, { type: "navigate", url: site.url });
          if (!nav.success) throw new Error(nav.error ?? "navigation failed");
          await executeAction(session, { type: "wait", condition: "network.idle", ms: 3000 });
          const model = await refreshPageModel(session);
          return site.agentBrowser(model);
        }).then(({ value, durationMs }) => ({ site: site.name, tool: "agent-browser" as const, success: value, durationMs }))
          .catch((err) => ({ site: site.name, tool: "agent-browser" as const, success: false, durationMs: 0, error: err.message })),
      ]);
      return [pwResult, abResult];
    })
  );

  // Teardown
  await Promise.all([pwBrowser.close(), closeSession(abSession.id)]);

  const results = allResults.flat();
  const totalMs = Date.now() - totalStart;

  // Print results
  console.log("SITE\t\t\t\tTOOL\t\t\tPASS\tMS");
  for (const r of results) {
    const pass = r.success ? "PASS" : "FAIL";
    console.log(`${r.site.padEnd(30)}\t${r.tool.padEnd(16)}\t${pass}\t${r.durationMs}ms${r.error ? ` — ${r.error.slice(0, 60)}` : ""}`);
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

  console.log(`\nTotal time: ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
