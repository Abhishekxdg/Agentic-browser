/**
 * Semantic Browser Evaluation Suite
 * Tests the semantic browser against 12 popular sites.
 *
 * Optimizations:
 * - Parallel execution (CONCURRENCY = 4)
 * - One session per concurrent slot, pre-warmed
 * - network.idle wait replaces fixed sleep
 * - Amazon 4000ms hardcoded wait removed
 */

import { createSession, closeSession, refreshPageModel, executeAction, getSession } from "../src/agent-browser/session-manager.ts";
import type { SemanticPage } from "../src/agent-browser/semantic-page.ts";

process.env.EXTENSION_DISABLED = "true";

const CONCURRENCY = 4;

interface TestResult {
  site: string;
  url: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  error?: string;
  durationMs: number;
}

const SITES: Array<{
  name: string;
  url: string;
  checks: Array<(p: SemanticPage) => { name: string; passed: boolean; detail?: string }>;
}> = [
  {
    name: "Example Domain",
    url: "https://example.com",
    checks: [
      (p) => ({ name: "page title", passed: p.page.title === "Example Domain" }),
      (p) => ({ name: "has heading", passed: p.content.some((c) => c.type === "heading" && c.text.includes("Example")) }),
      (p) => ({ name: "has navigation links", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "HTTPBin Forms",
    url: "https://httpbin.org/forms/post",
    checks: [
      (p) => ({ name: "has forms", passed: p.forms.length > 0 }),
      (p) => ({ name: "has custname field", passed: p.forms.some((f) => f.fields.some((fld) => fld.name === "custname")) }),
      (p) => ({ name: "has email field", passed: p.forms.some((f) => f.fields.some((fld) => fld.type === "email")) }),
      (p) => ({ name: "has submit button", passed: p.forms.some((f) => f.actions.some((a) => a.type === "submit" || a.action === "submit")) }),
    ],
  },
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has content", passed: p.content.length > 0 }),
      (p) => ({ name: "has navigation", passed: p.navigation.length > 0 }),
      (p) => ({ name: "has search", passed: p.search !== null }),
    ],
  },
  {
    name: "GitHub",
    url: "https://github.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has content or forms", passed: p.content.length > 0 || p.forms.length > 0 }),
      (p) => ({ name: "has nav or interactive", passed: p.navigation.length > 0 || p.interactive.length > 0 }),
    ],
  },
  {
    name: "Google",
    url: "https://www.google.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has search", passed: p.search !== null || p.forms.some((f) => f.fields.some((fld) => fld.type === "search" || fld.name === "q")) }),
    ],
  },
  {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has search", passed: p.search !== null || p.forms.some((f) => f.fields.some((fld) => fld.name.toLowerCase().includes("q"))) }),
    ],
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 }),
      (p) => ({ name: "has links", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "Reddit",
    url: "https://old.reddit.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 || p.page.url.length > 0 }),
      (p) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 }),
    ],
  },
  {
    name: "Amazon",
    url: "https://www.amazon.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 && !p.page.title.includes("Robot") }),
      (p) => ({ name: "has search or forms", passed: p.search !== null || p.forms.length > 0 || p.interactive.length > 0 }),
    ],
  },
  {
    name: "Stack Overflow",
    url: "https://stackoverflow.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 }),
    ],
  },
  {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org/en-US/docs/Web",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has headings", passed: p.content.some((c) => c.type === "heading") }),
      (p) => ({ name: "has navigation", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "Twitter/X",
    url: "https://x.com",
    checks: [
      (p) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p) => ({ name: "has forms or interactive", passed: p.forms.length > 0 || p.interactive.length > 0 }),
    ],
  },
];

async function runTest(
  site: (typeof SITES)[number],
  sessionId: string,
): Promise<TestResult> {
  const session = getSession(sessionId)!;
  const start = Date.now();
  const checks: TestResult["checks"] = [];

  try {
    const navResult = await executeAction(session, { type: "navigate", url: site.url });
    if (!navResult.success) {
      return { site: site.name, url: site.url, passed: false, checks,
        error: `Navigation failed: ${navResult.error}`, durationMs: Date.now() - start };
    }

    // network.idle: waits for actual network quiet (max 3s) — replaces fixed sleep
    await executeAction(session, { type: "wait", condition: "network.idle", ms: 3000 });

    const page = await refreshPageModel(session);

    for (const checkFn of site.checks) {
      try { checks.push(checkFn(page)); }
      catch (err) { checks.push({ name: "check error", passed: false, detail: err instanceof Error ? err.message : String(err) }); }
    }

    return { site: site.name, url: site.url, passed: checks.every((c) => c.passed), checks, durationMs: Date.now() - start };
  } catch (err) {
    return { site: site.name, url: site.url, passed: false, checks,
      error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`  Semantic Browser Eval — ${SITES.length} sites, concurrency ${CONCURRENCY}`);
  console.log("=".repeat(60) + "\n");

  const totalStart = Date.now();
  const results: TestResult[] = [];

  // Pre-warm all sessions upfront (CONCURRENCY Chrome processes)
  console.log(`[setup] spawning ${CONCURRENCY} Chrome sessions...`);
  const sessionPool = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => createSession({ browser: { headless: true } }))
  );
  console.log(`[setup] ready in ${Date.now() - totalStart}ms\n`);

  // Run sites in batches using the pre-warmed pool
  for (let i = 0; i < SITES.length; i += CONCURRENCY) {
    const batch = SITES.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((site, idx) => runTest(site, sessionPool[idx % CONCURRENCY]!.id))
    );
    results.push(...batchResults);
  }

  // Teardown
  await Promise.all(sessionPool.map((s) => closeSession(s.id)));

  const totalMs = Date.now() - totalStart;
  let passed = 0;

  for (const result of results) {
    if (result.passed) passed++;
    const icon = result.passed ? "✓" : "✗";
    console.log(`${icon} ${result.passed ? "PASS" : "FAIL"}  ${result.site} (${result.durationMs}ms)`);
    if (result.error) console.log(`    Error: ${result.error}`);
    for (const check of result.checks) {
      console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    console.log();
  }

  const rate = Math.round((passed / SITES.length) * 100);
  console.log("=".repeat(60));
  console.log(`  Results: ${passed}/${SITES.length} passed  (${rate}%)`);
  console.log(`  Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log("=".repeat(60));

  process.exit(rate >= 70 ? 0 : 1);
}

main();
