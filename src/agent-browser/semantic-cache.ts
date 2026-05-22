import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { SemanticPage } from "./semantic-page.ts";

interface CacheEntry {
  key: string;
  url: string;
  cached_at: number;
  hits: number;
  page: SemanticPage;
}

interface CacheStore {
  entries: Record<string, CacheEntry>;
}

const DEFAULT_TTL_MS = Number(process.env.SEMANTIC_CACHE_TTL_MS ?? "900000"); // 15 min
const memoryCache = new Map<string, CacheEntry>();
let loaded = false;

function cacheDir(): string {
  return process.env.SEMANTIC_CACHE_DIR ?? join(homedir(), ".sound-browser", "semantic-cache");
}

function cachePath(): string {
  return join(cacheDir(), "pages.json");
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return rawUrl;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const dir = cacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const file = cachePath();
  if (!existsSync(file)) return;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheStore;
    const entries = parsed.entries ?? {};
    for (const entry of Object.values(entries)) {
      memoryCache.set(entry.key, entry);
    }
  } catch {
    // Ignore malformed cache; rebuild from scratch on next writes.
  }
}

function persist(): void {
  ensureLoaded();
  const dir = cacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const entries: Record<string, CacheEntry> = {};
  for (const [key, value] of memoryCache.entries()) {
    entries[key] = value;
  }
  writeFileSync(cachePath(), JSON.stringify({ entries }, null, 2), "utf8");
}

export function getCachedSemanticPage(url: string, ttlMs = DEFAULT_TTL_MS): SemanticPage | null {
  ensureLoaded();
  const key = normalizeUrl(url);
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cached_at > ttlMs) {
    memoryCache.delete(key);
    persist();
    return null;
  }
  entry.hits += 1;
  memoryCache.set(key, entry);
  return entry.page;
}

export function setCachedSemanticPage(url: string, page: SemanticPage): void {
  ensureLoaded();
  const key = normalizeUrl(url);
  const existing = memoryCache.get(key);
  const next: CacheEntry = {
    key,
    url: page.page.url || url,
    cached_at: Date.now(),
    hits: (existing?.hits ?? 0) + 1,
    page,
  };
  memoryCache.set(key, next);
  persist();
}

export function listSemanticCacheEntries(): Array<{ url: string; cached_at: number; hits: number }> {
  ensureLoaded();
  return Array.from(memoryCache.values())
    .map((e) => ({ url: e.url, cached_at: e.cached_at, hits: e.hits }))
    .sort((a, b) => b.cached_at - a.cached_at);
}

export function clearSemanticCache(url?: string): number {
  ensureLoaded();
  if (!url) {
    const count = memoryCache.size;
    memoryCache.clear();
    persist();
    return count;
  }
  const key = normalizeUrl(url);
  const existed = memoryCache.delete(key);
  persist();
  return existed ? 1 : 0;
}
