/**
 * Site Memory — learned patterns, corrections, and preferences per site.
 * Persists to ~/.sound-browser/memory/<site_host>.json
 * Agents get smarter each run without re-recording.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";

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
