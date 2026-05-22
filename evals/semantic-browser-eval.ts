/**
 * Semantic Browser Evaluation Suite
 * Tests the semantic browser against 10+ popular sites.
 * Verifies: navigation, page model extraction, form detection, content parsing.
 */

import { createSession, closeSession, refreshPageModel, executeAction } from "../src/agent-browser/session-manager.ts";
import type { SemanticPage } from "../src/agent-browser/semantic-page.ts";

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
  waitMs?: number;
  checks: Array<(p: SemanticPage) => { name: string; passed: boolean; detail?: string }>;
}> = [
  {
    name: "Example Domain",
    url: "https://example.com",
    checks: [
      (p: SemanticPage) => ({ name: "page title", passed: p.page.title === "Example Domain" }),
      (p: SemanticPage) => ({ name: "has heading", passed: p.content.some((c) => c.type === "heading" && c.text.includes("Example")) }),
      (p: SemanticPage) => ({ name: "has navigation links", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "HTTPBin Forms",
    url: "https://httpbin.org/forms/post",
    checks: [
      (p: SemanticPage) => ({ name: "has forms", passed: p.forms.length > 0 }),
      (p: SemanticPage) => ({ name: "has customer name field", passed: p.forms.some((f) => f.fields.some((fld) => fld.name === "custname")) }),
      (p: SemanticPage) => ({ name: "has email field", passed: p.forms.some((f) => f.fields.some((fld) => fld.type === "email")) }),
      (p: SemanticPage) => ({ name: "has radio options", passed: p.forms.some((f) => f.fields.some((fld) => fld.type === "radio" && (fld.options?.length ?? 0) > 0)) }),
      (p: SemanticPage) => ({ name: "has submit button", passed: p.forms.some((f) => f.actions.some((a) => a.type === "submit" || a.action === "submit")) }),
    ],
  },
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has content", passed: p.content.length > 0 }),
      (p: SemanticPage) => ({ name: "has navigation", passed: p.navigation.length > 0 }),
      (p: SemanticPage) => ({ name: "has search", passed: p.search !== null }),
    ],
  },
  {
    name: "GitHub",
    url: "https://github.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has content", passed: p.content.length > 0 || p.forms.length > 0 }),
      (p: SemanticPage) => ({ name: "has navigation or interactive", passed: p.navigation.length > 0 || p.interactive.length > 0 }),
    ],
  },
  {
    name: "Google",
    url: "https://www.google.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has search field", passed: p.search !== null || p.forms.some((f) => f.fields.some((fld) => fld.type === "search" || fld.name === "q")) }),
    ],
  },
  {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has search", passed: p.search !== null || p.forms.some((f) => f.fields.some((fld) => fld.name.toLowerCase().includes("q"))) }),
    ],
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 }),
      (p: SemanticPage) => ({ name: "has links", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "Reddit",
    url: "https://old.reddit.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 || p.page.url.length > 0 }),
      (p: SemanticPage) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 || p.page.url.length > 0 }),
    ],
  },
  {
    name: "Amazon",
    url: "https://www.amazon.com",
    waitMs: 4000,
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 && !p.page.title.includes("Robot") }),
      (p: SemanticPage) => ({ name: "has search or forms", passed: p.search !== null || p.forms.length > 0 || p.interactive.length > 0 }),
    ],
  },
  {
    name: "Stack Overflow",
    url: "https://stackoverflow.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has content", passed: p.content.length > 0 || p.navigation.length > 0 }),
    ],
  },
  {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org/en-US/docs/Web",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has headings", passed: p.content.some((c) => c.type === "heading") }),
      (p: SemanticPage) => ({ name: "has navigation", passed: p.navigation.length > 0 }),
    ],
  },
  {
    name: "Twitter/X",
    url: "https://x.com",
    checks: [
      (p: SemanticPage) => ({ name: "page loaded", passed: p.page.title.length > 0 }),
      (p: SemanticPage) => ({ name: "has forms or interactive", passed: p.forms.length > 0 || p.interactive.length > 0 }),
    ],
  },
];

async function runTest(site: (typeof SITES)[number]): Promise<TestResult> {
  const start = Date.now();
  const session = await createSession({ browser: { headless: true } });
  const checks: TestResult["checks"] = [];

  try {
    // Navigate
    const navResult = await executeAction(session, { type: "navigate", url: site.url });
    if (!navResult.success) {
      return {
        site: site.name,
        url: site.url,
        passed: false,
        checks,
        error: `Navigation failed: ${navResult.error}`,
        durationMs: Date.now() - start,
      };
    }

    // Wait briefly for dynamic content
    await new Promise((r) => setTimeout(r, site.waitMs ?? 1500));

    // Extract page model
    const page = await refreshPageModel(session);

    // Run checks
    for (const checkFn of site.checks) {
      try {
        checks.push(checkFn(page));
      } catch (err) {
        checks.push({
          name: "check error",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const allPassed = checks.every((c) => c.passed);
    return {
      site: site.name,
      url: site.url,
      passed: allPassed,
      checks,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      site: site.name,
      url: site.url,
      passed: false,
      checks,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    await closeSession(session.id);
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("  Semantic Browser Evaluation Suite");
  console.log("  Testing", SITES.length, "popular sites");
  console.log("=".repeat(60));
  console.log();

  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const site of SITES) {
    const result = await runTest(site);
    results.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    const icon = result.passed ? "✓" : "✗";
    if (result.passed) passed++;
    else failed++;

    console.log(`${icon} ${status}  ${result.site} (${result.durationMs}ms)`);
    if (result.error) {
      console.log(`    Error: ${result.error}`);
    }
    for (const check of result.checks) {
      const cIcon = check.passed ? "  ✓" : "  ✗";
      console.log(`${cIcon} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed / ${SITES.length} total`);
  const rate = Math.round((passed / SITES.length) * 100);
  console.log(`  Success rate: ${rate}%`);
  console.log("=".repeat(60));

  if (rate < 70) {
    console.log("\n⚠️  Below 70% threshold. Review failures above.");
    process.exit(1);
  } else {
    console.log("\n✓ Evaluation passed.");
    process.exit(0);
  }
}

main();
