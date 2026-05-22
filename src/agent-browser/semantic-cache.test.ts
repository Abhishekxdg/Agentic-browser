import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  setCachedSemanticPage,
  getCachedSemanticPage,
  listSemanticCacheEntries,
  clearSemanticCache,
} from "./semantic-cache.ts";
import type { SemanticPage } from "./semantic-page.ts";

const TEST_CACHE_DIR = join(process.cwd(), ".tmp-semantic-cache-tests");

function fakePage(url: string, title = "Test"): SemanticPage {
  return {
    page: { url, title, viewport: { width: 1280, height: 720 } },
    forms: [],
    navigation: [],
    content: [],
    interactive: [],
    tables: [],
    lists: [],
    search: null,
    media: [],
    dialogs: [],
    iframes: [],
  };
}

describe("semantic page cache", () => {
  beforeAll(() => {
    process.env.SEMANTIC_CACHE_DIR = TEST_CACHE_DIR;
  });

  beforeEach(() => {
    clearSemanticCache();
  });

  afterAll(() => {
    clearSemanticCache();
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  });

  it("returns cached page for same URL", () => {
    setCachedSemanticPage("https://example.com/dashboard", fakePage("https://example.com/dashboard", "Dashboard"));
    const hit = getCachedSemanticPage("https://example.com/dashboard");
    expect(hit?.page.title).toBe("Dashboard");
    expect(listSemanticCacheEntries()).toHaveLength(1);
  });

  it("normalizes hash fragment in cache key", () => {
    setCachedSemanticPage("https://example.com/docs#intro", fakePage("https://example.com/docs#intro", "Docs"));
    const hit = getCachedSemanticPage("https://example.com/docs#advanced");
    expect(hit?.page.title).toBe("Docs");
  });

  it("expires stale entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setCachedSemanticPage("https://example.com/reports", fakePage("https://example.com/reports", "Reports"));
    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    const stale = getCachedSemanticPage("https://example.com/reports", 15 * 60 * 1000);
    expect(stale).toBeNull();
    vi.useRealTimers();
  });

  it("clears one url without deleting others", () => {
    setCachedSemanticPage("https://example.com/a", fakePage("https://example.com/a", "A"));
    setCachedSemanticPage("https://example.com/b", fakePage("https://example.com/b", "B"));
    const removed = clearSemanticCache("https://example.com/a");
    expect(removed).toBe(1);
    expect(getCachedSemanticPage("https://example.com/a")).toBeNull();
    expect(getCachedSemanticPage("https://example.com/b")?.page.title).toBe("B");
  });
});
