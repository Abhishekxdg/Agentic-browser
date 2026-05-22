/**
 * Site Intelligence Database — deepened per-site learning.
 * Stores: failure patterns, auth flows, interaction heuristics,
 * selector reliability, timing quirks, workflow success rates.
 * Gets smarter with every run. Compound value.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import type { ActionResult, ActionStrategy } from "./action-resolver.ts";

const INTELLIGENCE_DIR = join(homedir(), ".sound-browser", "intelligence");

// ── Data Models ────────────────────────────────────────────────────────────

export interface FailurePattern {
  id: string;
  action_type: string;
  target: string;
  error_signature: string; // normalized error message
  root_cause: string;
  recovery_strategy: string;
  success_count: number; // how many times this recovery worked
  failure_count: number;
  first_seen: string;
  last_seen: string;
}

export interface AuthFlow {
  login_url?: string;
  username_selector?: string;
  password_selector?: string;
  submit_selector?: string;
  two_factor_type?: "totp" | "sms" | "email" | "none";
  two_factor_selector?: string;
  post_login_indicator?: string; // e.g. "dashboard avatar visible"
  step_delay_ms?: number;
  is_oauth?: boolean;
  oauth_provider?: string;
}

export interface SelectorReliability {
  selector: string;
  purpose: string;
  success_count: number;
  failure_count: number;
  reliability: number; // 0-1 computed
  last_used: string;
}

export interface TimingHeuristic {
  action_type: string;
  min_delay_ms: number;
  max_delay_ms: number;
  avg_delay_ms: number;
  sample_count: number;
}

export interface WorkflowStat {
  workflow_name: string;
  run_count: number;
  success_count: number;
  avg_duration_ms: number;
  last_run: string;
}

export interface SiteIntelligence {
  site_host: string;
  version: number;
  last_updated: string;
  visit_count: number;
  // Failure learning
  failure_patterns: FailurePattern[];
  // Auth
  auth: AuthFlow;
  // Selector reliability scores
  selector_reliability: Record<string, SelectorReliability>; // key: selector
  // Timing
  timing: Record<string, TimingHeuristic>; // key: action_type
  // Workflow stats
  workflow_stats: Record<string, WorkflowStat>; // key: workflow_name
  // Interaction heuristics
  heuristics: {
    /** Pages that need extra wait after navigation */
    slow_pages: string[];
    /** Elements that need hover before click */
    hover_before_click: string[];
    /** Pages with dynamic content that needs polling */
    poll_required: string[];
    /** Common overlay/popup selectors that block actions */
    overlay_selectors: string[];
  };
  // Per-site reliability score (0-1)
  overall_reliability: number;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function intelligencePath(siteHost: string): string {
  const safe = siteHost.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(INTELLIGENCE_DIR, `${safe}.json`);
}

function ensureDir(): void {
  if (!existsSync(INTELLIGENCE_DIR)) mkdirSync(INTELLIGENCE_DIR, { recursive: true });
}

export function loadIntelligence(siteHost: string): SiteIntelligence {
  ensureDir();
  const path = intelligencePath(siteHost);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as SiteIntelligence;
  }
  return createEmpty(siteHost);
}

export function saveIntelligence(intel: SiteIntelligence): void {
  ensureDir();
  intel.last_updated = new Date().toISOString();
  intel.visit_count++;
  writeFileSync(intelligencePath(intel.site_host), JSON.stringify(intel, null, 2), "utf8");
}

function createEmpty(siteHost: string): SiteIntelligence {
  return {
    site_host: siteHost,
    version: 1,
    last_updated: new Date().toISOString(),
    visit_count: 0,
    failure_patterns: [],
    auth: {},
    selector_reliability: {},
    timing: {},
    workflow_stats: {},
    heuristics: {
      slow_pages: [],
      hover_before_click: [],
      poll_required: [],
      overlay_selectors: [],
    },
    overall_reliability: 0.5,
  };
}

// ── Failure Pattern Learning ────────────────────────────────────────────────

function normalizeError(error: string): string {
  // Normalize dynamic parts (IDs, timestamps, URLs)
  return error
    .replace(/\b[a-f0-9]{8,}\b/g, "<ID>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\b/g, "<TIME>")
    .replace(/https?:\/\/[^\s]+/g, "<URL>")
    .replace(/\d+/g, "<N>")
    .slice(0, 200);
}

export function recordFailure(
  siteHost: string,
  actionType: string,
  target: string,
  error: string,
  recoveryStrategy: string,
  recovered: boolean,
): void {
  const intel = loadIntelligence(siteHost);
  const signature = normalizeError(error);

  const existing = intel.failure_patterns.find(
    (p) => p.action_type === actionType && p.error_signature === signature,
  );

  if (existing) {
    existing.last_seen = new Date().toISOString();
    if (recovered) {
      existing.success_count++;
    } else {
      existing.failure_count++;
    }
  } else {
    intel.failure_patterns.push({
      id: `fp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action_type: actionType,
      target,
      error_signature: signature,
      root_cause: error.slice(0, 100),
      recovery_strategy: recoveryStrategy,
      success_count: recovered ? 1 : 0,
      failure_count: recovered ? 0 : 1,
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    });
  }

  // Sort by success rate descending
  intel.failure_patterns.sort((a, b) => {
    const rateA = a.success_count / (a.success_count + a.failure_count + 1);
    const rateB = b.success_count / (b.success_count + b.failure_count + 1);
    return rateB - rateA;
  });

  saveIntelligence(intel);
}

export function getRecoveryForFailure(
  siteHost: string,
  actionType: string,
  error: string,
): { strategy: string; successRate: number } | null {
  const intel = loadIntelligence(siteHost);
  const signature = normalizeError(error);

  const pattern = intel.failure_patterns.find(
    (p) => p.action_type === actionType && p.error_signature === signature,
  );

  if (!pattern) return null;

  const total = pattern.success_count + pattern.failure_count;
  const successRate = total > 0 ? pattern.success_count / total : 0;
  return { strategy: pattern.recovery_strategy, successRate };
}

// ── Selector Reliability ─────────────────────────────────────────────────────

export function recordSelectorResult(
  siteHost: string,
  selector: string,
  purpose: string,
  success: boolean,
): void {
  const intel = loadIntelligence(siteHost);
  const existing = intel.selector_reliability[selector];

  if (existing) {
    existing.success_count += success ? 1 : 0;
    existing.failure_count += success ? 0 : 1;
    existing.reliability = existing.success_count / (existing.success_count + existing.failure_count);
    existing.last_used = new Date().toISOString();
  } else {
    intel.selector_reliability[selector] = {
      selector,
      purpose,
      success_count: success ? 1 : 0,
      failure_count: success ? 0 : 1,
      reliability: success ? 1 : 0,
      last_used: new Date().toISOString(),
    };
  }

  saveIntelligence(intel);
}

export function getBestSelector(
  siteHost: string,
  purpose: string,
): { selector: string; reliability: number } | null {
  const intel = loadIntelligence(siteHost);
  const candidates = Object.values(intel.selector_reliability)
    .filter((s) => s.purpose === purpose || purpose.includes(s.purpose) || s.purpose.includes(purpose))
    .sort((a, b) => b.reliability - a.reliability);

  if (candidates.length === 0) return null;
  return { selector: candidates[0]!.selector, reliability: candidates[0]!.reliability };
}

// ── Timing Heuristics ──────────────────────────────────────────────────────

export function recordTiming(
  siteHost: string,
  actionType: string,
  durationMs: number,
): void {
  const intel = loadIntelligence(siteHost);
  const existing = intel.timing[actionType];

  if (existing) {
    existing.sample_count++;
    existing.min_delay_ms = Math.min(existing.min_delay_ms, durationMs);
    existing.max_delay_ms = Math.max(existing.max_delay_ms, durationMs);
    existing.avg_delay_ms =
      (existing.avg_delay_ms * (existing.sample_count - 1) + durationMs) / existing.sample_count;
  } else {
    intel.timing[actionType] = {
      action_type: actionType,
      min_delay_ms: durationMs,
      max_delay_ms: durationMs,
      avg_delay_ms: durationMs,
      sample_count: 1,
    };
  }

  saveIntelligence(intel);
}

export function getRecommendedDelay(siteHost: string, actionType: string): number {
  const intel = loadIntelligence(siteHost);
  const timing = intel.timing[actionType];
  if (!timing) return 0;
  // Use average + 1 stddev approximation (max - avg as rough proxy)
  const buffer = Math.min(500, timing.max_delay_ms - timing.avg_delay_ms);
  return Math.round(timing.avg_delay_ms + buffer);
}

// ── Auth Flow Learning ─────────────────────────────────────────────────────

export function recordAuthFlow(siteHost: string, auth: Partial<AuthFlow>): void {
  const intel = loadIntelligence(siteHost);
  intel.auth = { ...intel.auth, ...auth };
  saveIntelligence(intel);
}

export function getAuthFlow(siteHost: string): AuthFlow {
  return loadIntelligence(siteHost).auth;
}

// ── Workflow Stats ───────────────────────────────────────────────────────────

export function recordWorkflowRun(
  siteHost: string,
  workflowName: string,
  success: boolean,
  durationMs: number,
): void {
  const intel = loadIntelligence(siteHost);
  const existing = intel.workflow_stats[workflowName];

  if (existing) {
    existing.run_count++;
    existing.success_count += success ? 1 : 0;
    existing.avg_duration_ms =
      (existing.avg_duration_ms * (existing.run_count - 1) + durationMs) / existing.run_count;
    existing.last_run = new Date().toISOString();
  } else {
    intel.workflow_stats[workflowName] = {
      workflow_name: workflowName,
      run_count: 1,
      success_count: success ? 1 : 0,
      avg_duration_ms: durationMs,
      last_run: new Date().toISOString(),
    };
  }

  // Recalculate overall reliability
  const allStats = Object.values(intel.workflow_stats);
  const totalRuns = allStats.reduce((s, w) => s + w.run_count, 0);
  const totalSuccess = allStats.reduce((s, w) => s + w.success_count, 0);
  intel.overall_reliability = totalRuns > 0 ? totalSuccess / totalRuns : 0.5;

  saveIntelligence(intel);
}

export function getWorkflowStats(siteHost: string, workflowName: string): WorkflowStat | null {
  return loadIntelligence(siteHost).workflow_stats[workflowName] ?? null;
}

// ── Heuristics ───────────────────────────────────────────────────────────────

export function addHeuristic(
  siteHost: string,
  category: "slow_pages" | "hover_before_click" | "poll_required" | "overlay_selectors",
  value: string,
): void {
  const intel = loadIntelligence(siteHost);
  const list = intel.heuristics[category];
  if (!list.includes(value)) {
    list.push(value);
    saveIntelligence(intel);
  }
}

export function getHeuristics(siteHost: string): SiteIntelligence["heuristics"] {
  return loadIntelligence(siteHost).heuristics;
}

// ── Query ────────────────────────────────────────────────────────────────────

export function listIntelligence(): Array<{
  site_host: string;
  visit_count: number;
  overall_reliability: number;
  failure_patterns: number;
  last_updated: string;
}> {
  ensureDir();
  return readdirSync(INTELLIGENCE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const intel: SiteIntelligence = JSON.parse(readFileSync(join(INTELLIGENCE_DIR, f), "utf8"));
        return {
          site_host: intel.site_host,
          visit_count: intel.visit_count,
          overall_reliability: intel.overall_reliability,
          failure_patterns: intel.failure_patterns.length,
          last_updated: intel.last_updated,
        };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{
      site_host: string;
      visit_count: number;
      overall_reliability: number;
      failure_patterns: number;
      last_updated: string;
    }>;
}
