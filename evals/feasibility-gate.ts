/**
 * Feasibility Gate Test Script
 *
 * Tests the hybrid execution engine on 5 diverse websites.
 * Measures success rates for API replay, DOM control, and Vision AI fallback.
 *
 * Run: bun run evals/feasibility-gate.ts
 */

import { HybridExecutionEngine, type HybridEngineConfig } from "../src/executor/hybrid-engine.ts";

interface TestSite {
  name: string;
  url: string;
  category: string; // "spa", "server-rendered", "ecommerce", "social", "legacy"
  intent: string;
  requiresAuth: boolean;
  expectedOutcome: string;
}

const TEST_SITES: TestSite[] = [
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    category: "server-rendered",
    intent: "Search for 'artificial intelligence' and read the first paragraph",
    requiresAuth: false,
    expectedOutcome: "Page navigates to AI article with content extracted",
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    category: "server-rendered",
    intent: "Click the first news story and extract the title",
    requiresAuth: false,
    expectedOutcome: "First story clicked, title extracted",
  },
  {
    name: "Example SPA (JSONPlaceholder)",
    url: "https://jsonplaceholder.typicode.com",
    category: "spa",
    intent: "Navigate to posts endpoint and list first 5 post titles",
    requiresAuth: false,
    expectedOutcome: "Posts page loaded, titles extracted",
  },
  {
    name: "httpbin",
    url: "https://httpbin.org/forms/post",
    category: "legacy",
    intent: "Fill the form with name 'Test User' and email 'test@example.com'",
    requiresAuth: false,
    expectedOutcome: "Form submitted with correct values",
  },
  {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com",
    category: "search",
    intent: "Search for 'playwright browser automation'",
    requiresAuth: false,
    expectedOutcome: "Search results page loaded",
  },
];

interface TestResult {
  site: string;
  category: string;
  intent: string;
  success: boolean;
  strategy_used: string;
  steps_executed: number;
  error?: string;
  duration_ms: number;
}

async function runTest(site: TestSite, config: HybridEngineConfig): Promise<TestResult> {
  const engine = new HybridExecutionEngine(config);
  const start = Date.now();

  try {
    console.log(`\n  Testing: ${site.name} (${site.category})`);
    console.log(`  Intent: ${site.intent}`);

    const result = await engine.execute(site.url, site.intent);
    const duration = Date.now() - start;

    const success = result.status === "success";
    console.log(`  Result: ${success ? "PASS" : "FAIL"} | Strategy: ${result.strategy_used} | Steps: ${result.steps_executed} | ${duration}ms`);
    if (result.error) console.log(`  Error: ${result.error}`);

    return {
      site: site.name,
      category: site.category,
      intent: site.intent,
      success,
      strategy_used: result.strategy_used,
      steps_executed: result.steps_executed,
      error: result.error,
      duration_ms: duration,
    };
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`  Result: FAIL | Exception: ${err instanceof Error ? err.message : String(err)} | ${duration}ms`);

    return {
      site: site.name,
      category: site.category,
      intent: site.intent,
      success: false,
      strategy_used: "none",
      steps_executed: 0,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: duration,
    };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("AGENT BROWSER — FEASIBILITY GATE");
  console.log("=".repeat(60));
  console.log(`Testing ${TEST_SITES.length} sites with hybrid execution engine\n`);

  const config: HybridEngineConfig = {
    browser: { headless: true }, // Run headless for automated testing
    vision: process.env.OPENAI_API_KEY
      ? {
          apiKey: process.env.OPENAI_API_KEY,
          provider: "openai",
          model: "gpt-4o",
        }
      : undefined,
  };

  const results: TestResult[] = [];
  for (const site of TEST_SITES) {
    const result = await runTest(site, config);
    results.push(result);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.success).length;
  const rate = (passed / results.length) * 100;

  console.log(`\nTotal sites tested: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${results.length - passed}`);
  console.log(`Success rate: ${rate.toFixed(1)}%`);

  // Breakdown by strategy
  const strategies = new Map<string, number>();
  for (const r of results) {
    if (r.success) {
      strategies.set(r.strategy_used, (strategies.get(r.strategy_used) ?? 0) + 1);
    }
  }

  console.log(`\nSuccessful executions by strategy:`);
  for (const [strategy, count] of strategies) {
    console.log(`  ${strategy}: ${count}`);
  }

  // Per-site breakdown
  console.log(`\nPer-site results:`);
  for (const r of results) {
    const icon = r.success ? "✓" : "✗";
    console.log(`  ${icon} ${r.site} (${r.category}) — ${r.strategy_used} — ${r.duration_ms}ms`);
    if (r.error) console.log(`    Error: ${r.error.slice(0, 100)}`);
  }

  // Gate verdict
  console.log("\n" + "=".repeat(60));
  const GATE_THRESHOLD = 80;
  if (rate >= GATE_THRESHOLD) {
    console.log(`✓ FEASIBILITY GATE PASSED (${rate.toFixed(1)}% >= ${GATE_THRESHOLD}%)`);
    console.log("Proceed to platform development (T9+).");
  } else {
    console.log(`✗ FEASIBILITY GATE FAILED (${rate.toFixed(1)}% < ${GATE_THRESHOLD}%)`);
    console.log("Required: Fix failing strategies before building platform code.");
  }
  console.log("=".repeat(60));

  // Exit with appropriate code
  process.exit(rate >= GATE_THRESHOLD ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
