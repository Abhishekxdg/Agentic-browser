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

// Async wrappers with optional Postgres backing. Uses Bun.sql if SOUND_CACHE_BACKEND=postgres and Bun.sql available.
let _pgCache: any = null;
let _pgCacheReady = false;

async function ensureCachePostgresReady(): Promise<any | null> {
  if (_pgCacheReady) return _pgCache;
  try {
    const BunSql = (globalThis as any).Bun?.sql;
    const usePg = (process.env.SOUND_CACHE_BACKEND || "") === "postgres";
    if (!usePg || !BunSql) return null;
    _pgCache = BunSql;
    try {
      await _pgCache`CREATE TABLE IF NOT EXISTS sound_semantic_cache (key TEXT PRIMARY KEY, url TEXT, payload TEXT, cached_at INTEGER, hits INTEGER)`;
    } catch (e) {
      console.warn("semantic-cache: Postgres table ensure failed", e);
      return null;
    }
    _pgCacheReady = true;
    return _pgCache;
  } catch (e) {
    console.warn("semantic-cache: Postgres not available", e);
    return null;
  }
}

export async function getCachedSemanticPageAsync(url: string, ttlMs = DEFAULT_TTL_MS): Promise<SemanticPage | null> {
  const pg = await ensureCachePostgresReady();
  if (pg) {
    try {
      const key = normalizeUrl(url);
      const rows = await pg`SELECT payload, cached_at FROM sound_semantic_cache WHERE key = ${key}`;
      if (rows && rows.length) {
        const { payload, cached_at } = rows[0];
        if (Date.now() - Number(cached_at) > ttlMs) {
          // stale
          await pg`DELETE FROM sound_semantic_cache WHERE key = ${key}`;
          return null;
        }
        return JSON.parse(payload);
      }
      return null;
    } catch (e) {
      console.warn("semantic-cache: postgres get failed, falling back to fs", e);
    }
  }
  return getCachedSemanticPage(url, ttlMs);
}

export async function setCachedSemanticPageAsync(url: string, page: SemanticPage): Promise<void> {
  const pg = await ensureCachePostgresReady();
  if (pg) {
    try {
      const key = normalizeUrl(url);
      const payload = JSON.stringify(page);
      const now = Date.now();
      await pg`INSERT INTO sound_semantic_cache (key, url, payload, cached_at, hits) VALUES (${key}, ${page.page.url || url}, ${payload}, ${now}, ${1}) ON CONFLICT (key) DO UPDATE SET payload = ${payload}, cached_at = ${now}, hits = sound_semantic_cache.hits + 1, url = ${page.page.url || url}`;
      return;
    } catch (e) {
      console.warn("semantic-cache: postgres set failed, falling back to fs", e);
    }
  }
  return setCachedSemanticPage(url, page);
}

export async function listSemanticCacheEntriesAsync(): Promise<Array<{ url: string; cached_at: number; hits: number }>> {
  const pg = await ensureCachePostgresReady();
  if (pg) {
    try {
      const rows = await pg`SELECT url, cached_at, hits FROM sound_semantic_cache ORDER BY cached_at DESC`;
      return (rows || []).map((r: any) => ({ url: r.url, cached_at: Number(r.cached_at), hits: Number(r.hits) }));
    } catch (e) {
      console.warn("semantic-cache: postgres list failed, falling back to fs", e);
    }
  }
  return listSemanticCacheEntries();
}

export async function clearSemanticCacheAsync(url?: string): Promise<number> {
  const pg = await ensureCachePostgresReady();
  if (pg) {
    try {
      if (!url) {
        await pg`DELETE FROM sound_semantic_cache`;
        return 0; // count unknown
      }
      const key = normalizeUrl(url);
      await pg`DELETE FROM sound_semantic_cache WHERE key = ${key}`;
      return 1;
    } catch (e) {
      console.warn("semantic-cache: postgres clear failed, falling back to fs", e);
    }
  }
  return clearSemanticCache(url);
}
