/**
 * Feasibility Gate
 * Tests hybrid execution on 5 sites.
 *
 * Optimizations:
 * - Parallel execution (all 5 sites at once)
 * - One HybridExecutionEngine reused across tests (one Playwright browser)
 */

import { HybridExecutionEngine, type HybridEngineConfig } from "../src/executor/hybrid-engine.ts";

interface TestSite {
  name: string;
  url: string;
  category: string;
  intent: string;
  expectedOutcome: string;
}

const TEST_SITES: TestSite[] = [
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    category: "server-rendered",
    intent: "Search for 'artificial intelligence' and read the first paragraph",
    expectedOutcome: "Page navigates to AI article with content extracted",
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    category: "server-rendered",
    intent: "Click the first news story and extract the title",
    expectedOutcome: "First story clicked, title extracted",
  },
  {
    name: "JSONPlaceholder",
    url: "https://jsonplaceholder.typicode.com",
    category: "spa",
    intent: "Navigate to posts endpoint and list first 5 post titles",
    expectedOutcome: "Posts page loaded, titles extracted",
  },
  {
    name: "httpbin",
    url: "https://httpbin.org/forms/post",
    category: "legacy",
    intent: "Fill the form with name 'Test User' and email 'test@example.com'",
    expectedOutcome: "Form submitted with correct values",
  },
  {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com",
    category: "search",
    intent: "Search for 'playwright browser automation'",
    expectedOutcome: "Search results page loaded",
  },
];

interface TestResult {
  site: string;
  category: string;
  success: boolean;
  strategy_used: string;
  steps_executed: number;
  error?: string;
  duration_ms: number;
}

async function runTest(site: TestSite, engine: HybridExecutionEngine): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await engine.execute(site.url, site.intent);
    return {
      site: site.name, category: site.category,
      success: result.status === "success",
      strategy_used: result.strategy_used,
      steps_executed: result.steps_executed,
      error: result.error,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      site: site.name, category: site.category,
      success: false, strategy_used: "none", steps_executed: 0,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`FEASIBILITY GATE — ${TEST_SITES.length} sites in parallel`);
  console.log("=".repeat(60) + "\n");

  const config: HybridEngineConfig = {
    browser: { headless: true },
    vision: process.env.OPENAI_API_KEY
      ? { apiKey: process.env.OPENAI_API_KEY, provider: "openai", model: "gpt-4o" }
      : undefined,
  };

  // One shared engine (one Playwright browser) for all tests
  const engine = new HybridExecutionEngine(config);

  const totalStart = Date.now();

  // All 5 tests in parallel
  const results = await Promise.all(TEST_SITES.map((site) => runTest(site, engine)));

  const totalMs = Date.now() - totalStart;
  const passed = results.filter((r) => r.success).length;
  const rate = (passed / results.length) * 100;

  for (const r of results) {
    const icon = r.success ? "✓" : "✗";
    console.log(`${icon} ${r.site} (${r.category}) — ${r.strategy_used} — ${r.duration_ms}ms`);
    if (r.error) console.log(`    Error: ${r.error.slice(0, 120)}`);
  }

  const strategies = new Map<string, number>();
  for (const r of results) {
    if (r.success) strategies.set(r.strategy_used, (strategies.get(r.strategy_used) ?? 0) + 1);
  }

  console.log(`\nStrategy breakdown:`);
  for (const [s, c] of strategies) console.log(`  ${s}: ${c}`);

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${results.length} passed  (${rate.toFixed(1)}%)`);
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s`);

  const GATE = 80;
  if (rate >= GATE) {
    console.log(`✓ FEASIBILITY GATE PASSED (${rate.toFixed(1)}% >= ${GATE}%)`);
  } else {
    console.log(`✗ FEASIBILITY GATE FAILED (${rate.toFixed(1)}% < ${GATE}%)`);
  }
  console.log("=".repeat(60));

  process.exit(rate >= GATE ? 0 : 1);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
