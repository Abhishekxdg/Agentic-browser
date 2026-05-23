/**
 * Site Memory — learned patterns, corrections, and preferences per site.
 * Persists to ~/.sound-browser/memory/<site_host>.json
 * Agents get smarter each run without re-recording.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { unlink } from "fs/promises";

const MEMORY_DIR = join(homedir(), ".sound-browser", "memory");
const _cache = new Map<string, { memory: SiteMemory; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

export interface SiteCorrection {
  original_action: string;
  corrected_action: string;
  reason: string;
  success_count: number;
  created_at: string;
}

export interface SitePattern {
  selector: string;
  field_name: string;
  confidence: number; // 0-1, increases with usage
}

export interface SiteMemory {
  site_host: string;
  last_updated: string;
  visit_count: number;
  // Known corrections: "click Submit" broke → use "click_selector #submit-btn" instead
  corrections: SiteCorrection[];
  // Timing quirks: some sites need delay after fill before submit
  timing_hints: Record<string, number>; // action_type → delay_ms
  // Reliable selectors learned over time
  field_selectors: Record<string, SitePattern>; // field_name → best selector
  // Auth patterns
  auth: {
    login_url?: string;
    username_selector?: string;
    password_selector?: string;
    submit_selector?: string;
    post_login_indicator?: string; // selector visible after successful login
    needs_step_delay?: number; // ms delay between email submit and password reveal
  };
  // Known CAPTCHA patterns
  captcha: {
    type?: string;
    site_key?: string;
  };
}

function memoryPath(siteHost: string): string {
  const safe = siteHost.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(MEMORY_DIR, `${safe}.json`);
}

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

export function loadMemory(siteHost: string): SiteMemory {
  const cached = _cache.get(siteHost);
  if (cached && Date.now() < cached.expiresAt) return cached.memory;

  ensureDir();
  const path = memoryPath(siteHost);
  const memory: SiteMemory = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { site_host: siteHost, last_updated: new Date().toISOString(), visit_count: 0, corrections: [], timing_hints: {}, field_selectors: {}, auth: {}, captcha: {} };

  _cache.set(siteHost, { memory, expiresAt: Date.now() + CACHE_TTL_MS });
  return memory;
}

export function saveMemory(memory: SiteMemory): void {
  _cache.delete(memory.site_host); // invalidate cache on write
  ensureDir();
  memory.last_updated = new Date().toISOString();
  memory.visit_count++;
  writeFileSync(memoryPath(memory.site_host), JSON.stringify(memory, null, 2), "utf8");
}

export function addCorrection(siteHost: string, original: string, corrected: string, reason: string): void {
  const mem = loadMemory(siteHost);
  const existing = mem.corrections.find((c) => c.original_action === original);
  if (existing) {
    existing.corrected_action = corrected;
    existing.reason = reason;
    existing.success_count++;
  } else {
    mem.corrections.push({ original_action: original, corrected_action: corrected, reason, success_count: 1, created_at: new Date().toISOString() });
  }
  saveMemory(mem);
}

export function getCorrection(siteHost: string, failedAction: string): SiteCorrection | null {
  const mem = loadMemory(siteHost);
  return mem.corrections.find((c) => c.original_action === failedAction) ?? null;
}

export function learnSelector(siteHost: string, fieldName: string, selector: string, confidence: number): void {
  const mem = loadMemory(siteHost);
  const existing = mem.field_selectors[fieldName];
  if (!existing || confidence > existing.confidence) {
    mem.field_selectors[fieldName] = { selector, field_name: fieldName, confidence };
    saveMemory(mem);
  }
}

export function learnAuthPattern(siteHost: string, auth: Partial<SiteMemory["auth"]>): void {
  const mem = loadMemory(siteHost);
  mem.auth = { ...mem.auth, ...auth };
  saveMemory(mem);
}

export function learnTimingHint(siteHost: string, actionType: string, delayMs: number): void {
  const mem = loadMemory(siteHost);
  mem.timing_hints[actionType] = delayMs;
  saveMemory(mem);
}

export function listMemories(): Array<{ site_host: string; visit_count: number; corrections: number; last_updated: string }> {
  ensureDir();
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const m: SiteMemory = JSON.parse(readFileSync(join(MEMORY_DIR, f), "utf8"));
        return { site_host: m.site_host, visit_count: m.visit_count, corrections: m.corrections.length, last_updated: m.last_updated };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{ site_host: string; visit_count: number; corrections: number; last_updated: string }>;
}

// Async wrappers with optional Postgres backing. When Bun.sql is available and
// SOUND_MEMORY_BACKEND=postgres, operations use Postgres. Otherwise fall back to file-backed behavior.
let _pg: any = null;
let _pgReady = false;
let _pgEnabled: boolean | null = null;

async function ensurePostgresReady(): Promise<any | null> {
  if (_pgReady) return _pg;
  try {
    const BunSql = (globalThis as any).Bun?.sql;
    const configuredBackend = process.env.SOUND_MEMORY_BACKEND ?? process.env.SOUND_BACKEND;
    const hasDatabaseUrl = !!(process.env.SOUND_DATABASE_URL ?? process.env.DATABASE_URL);
    const usePg = configuredBackend === "postgres" || (!configuredBackend && hasDatabaseUrl);
    _pgEnabled = usePg && !!BunSql;
    if (!usePg || !BunSql) return null;
    _pg = BunSql;
    // Ensure table exists
    try {
      await _pg`CREATE TABLE IF NOT EXISTS sound_site_memories (site_host TEXT PRIMARY KEY, payload TEXT NOT NULL, last_updated TEXT NOT NULL, visit_count INTEGER NOT NULL DEFAULT 0)`;
      await _pg`CREATE INDEX IF NOT EXISTS idx_sound_site_memories_updated ON sound_site_memories (last_updated)`;
    } catch (e) {
      console.warn("site-memory: Postgres table ensure failed", e);
      _pgEnabled = false;
      return null;
    }
    _pgReady = true;
    return _pg;
  } catch (e) {
    console.warn("site-memory: Postgres not available", e);
    _pgEnabled = false;
    return null;
  }
}

export async function getMemoryBackend(): Promise<{ backend: "postgres" | "file"; postgres_ready: boolean }> {
  await ensurePostgresReady();
  return { backend: _pgReady && _pgEnabled !== false ? "postgres" : "file", postgres_ready: _pgReady };
}

export async function loadMemoryAsync(siteHost: string): Promise<SiteMemory> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      const rows = await pg`SELECT payload FROM sound_site_memories WHERE site_host = ${siteHost}`;
      if (rows && rows.length && rows[0]?.payload) {
        return JSON.parse(rows[0].payload);
      }
      // not found — create default
      const defaultMem: SiteMemory = { site_host: siteHost, last_updated: new Date().toISOString(), visit_count: 0, corrections: [], timing_hints: {}, field_selectors: {}, auth: {}, captcha: {} };
      await pg`INSERT INTO sound_site_memories (site_host, payload, last_updated, visit_count) VALUES (${siteHost}, ${JSON.stringify(defaultMem)}, ${defaultMem.last_updated}, ${defaultMem.visit_count})`;
      return defaultMem;
    } catch (e) {
      console.warn("site-memory: postgres load failed, falling back to fs", e);
    }
  }
  return loadMemory(siteHost);
}

export async function saveMemoryAsync(memory: SiteMemory): Promise<void> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      memory.last_updated = new Date().toISOString();
      memory.visit_count++;
      await pg`INSERT INTO sound_site_memories (site_host, payload, last_updated, visit_count) VALUES (${memory.site_host}, ${JSON.stringify(memory)}, ${memory.last_updated}, ${memory.visit_count}) ON CONFLICT (site_host) DO UPDATE SET payload = ${JSON.stringify(memory)}, last_updated = ${memory.last_updated}, visit_count = ${memory.visit_count}`;
      return;
    } catch (e) {
      console.warn("site-memory: postgres save failed, falling back to fs", e);
    }
  }
  return saveMemory(memory);
}

export async function addCorrectionAsync(siteHost: string, original: string, corrected: string, reason: string): Promise<void> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      const loaded = await loadMemoryAsync(siteHost);
      const existing = loaded.corrections.find((c) => c.original_action === original);
      if (existing) {
        existing.corrected_action = corrected;
        existing.reason = reason;
        existing.success_count++;
      } else {
        loaded.corrections.push({ original_action: original, corrected_action: corrected, reason, success_count: 1, created_at: new Date().toISOString() });
      }
      await saveMemoryAsync(loaded);
      return;
    } catch (e) {
      console.warn("site-memory: postgres addCorrection failed, falling back to fs", e);
    }
  }
  return addCorrection(siteHost, original, corrected, reason);
}

export async function getCorrectionAsync(siteHost: string, failedAction: string): Promise<SiteCorrection | null> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      const mem = await loadMemoryAsync(siteHost);
      return mem.corrections.find((c) => c.original_action === failedAction) ?? null;
    } catch (e) {
      console.warn("site-memory: postgres getCorrection failed, falling back to fs", e);
    }
  }
  return getCorrection(siteHost, failedAction);
}

export async function listMemoriesAsync(): Promise<Array<{ site_host: string; visit_count: number; corrections: number; last_updated: string }>> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      const rows = await pg`SELECT payload FROM sound_site_memories`;
      return (rows || []).map((r: any) => {
        const m: SiteMemory = JSON.parse(r.payload);
        return { site_host: m.site_host, visit_count: m.visit_count, corrections: m.corrections.length, last_updated: m.last_updated };
      });
    } catch (e) {
      console.warn("site-memory: postgres list failed, falling back to fs", e);
    }
  }
  return listMemories();
}

export async function deleteMemoryAsync(siteHost: string): Promise<boolean> {
  const pg = await ensurePostgresReady();
  if (pg) {
    try {
      await pg`DELETE FROM sound_site_memories WHERE site_host = ${siteHost}`;
      _cache.delete(siteHost);
      return true;
    } catch (e) {
      console.warn("site-memory: postgres delete failed, falling back to fs", e);
    }
  }
  const path = memoryPath(siteHost);
  if (existsSync(path)) {
    await unlink(path);
    _cache.delete(siteHost);
    return true;
  }
  return false;
}
