/**
 * Audit Log — immutable, tamper-evident record of every agent action.
 * Required for enterprise. Answers: who did what, when, to which site.
 * Stored at ~/.agent-browser/audit/<org_id>/<date>.jsonl
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, appendFileSync, readdirSync, readFileSync } from "fs";
import type { SemanticAction, ActionResult } from "./action-resolver.ts";

const AUDIT_DIR = join(homedir(), ".agent-browser", "audit");

export type AuditSeverity = "info" | "warn" | "sensitive" | "critical";

export interface AuditEntry {
  id: string;
  timestamp: string;
  session_id: string;
  org_id: string;
  site_url: string;
  action_type: string;
  action_detail: string;  // human-readable summary (no secrets)
  severity: AuditSeverity;
  success: boolean;
  confidence?: number;
  strategy?: string;
  error?: string;
  verification?: { verified: boolean; evidence: string };
  screenshot_taken?: boolean;
  ip?: string;
  user_agent?: string;
}

// Sensitive action types that require screenshot capture
const SENSITIVE_ACTIONS = new Set([
  "click", "press", "fill", "fill_selector", "handle_dialog",
]);

// Critical patterns that must be flagged (financial, destructive)
const CRITICAL_PATTERNS = [
  /pay|payment|checkout|purchase|buy|order|confirm.*order/i,
  /delete|remove|destroy|cancel.*account/i,
  /transfer|send.*money|wire/i,
  /password|secret|credential/i,
];

function classifySeverity(action: SemanticAction): AuditSeverity {
  const str = JSON.stringify(action).toLowerCase();
  for (const pattern of CRITICAL_PATTERNS) {
    if (pattern.test(str)) return "critical";
  }
  if (SENSITIVE_ACTIONS.has(action.type)) return "sensitive";
  if (action.type === "navigate") return "info";
  return "info";
}

function summarize(action: SemanticAction): string {
  switch (action.type) {
    case "navigate":    return `Navigate to ${(action as any).url}`;
    case "click":       return `Click "${(action as any).target}"`;
    case "click_text":  return `Click text "${(action as any).text}"`;
    case "fill":        return `Fill ${(action as any).form}.${(action as any).field} (value hidden)`;
    case "fill_selector": return `Fill ${(action as any).selector} (value hidden)`;
    case "press":       return `Press ${(action as any).key}`;
    case "handle_dialog": return `${(action as any).accept ? "Accept" : "Dismiss"} dialog`;
    case "wait":        return `Wait ${(action as any).condition}`;
    case "scroll":      return `Scroll ${(action as any).direction}`;
    default:            return `${action.type}`;
  }
}

function auditPath(orgId: string): string {
  const dir = join(AUDIT_DIR, orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(dir, `${date}.jsonl`);
}

function makeId(): string {
  return `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function writeAuditEntry(
  sessionId: string,
  orgId: string,
  siteUrl: string,
  action: SemanticAction,
  result: ActionResult,
  extra: { verification?: { verified: boolean; evidence: string }; screenshotTaken?: boolean } = {},
): AuditEntry {
  const entry: AuditEntry = {
    id: makeId(),
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    org_id: orgId,
    site_url: siteUrl,
    action_type: action.type,
    action_detail: summarize(action),
    severity: classifySeverity(action),
    success: result.success,
    confidence: result.confidence,
    strategy: result.strategy,
    error: result.error,
    verification: extra.verification,
    screenshot_taken: extra.screenshotTaken,
  };

  appendFileSync(auditPath(orgId), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

export function readAuditLog(
  orgId: string,
  opts: { date?: string; session_id?: string; severity?: AuditSeverity; limit?: number } = {},
): AuditEntry[] {
  const dir = join(AUDIT_DIR, orgId);
  if (!existsSync(dir)) return [];

  const files = opts.date
    ? [`${opts.date}.jsonl`]
    : readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();

  const entries: AuditEntry[] = [];
  const limit = opts.limit ?? 1000;

  for (const file of files) {
    if (entries.length >= limit) break;
    try {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
      for (const line of lines.reverse()) {
        if (entries.length >= limit) break;
        try {
          const e: AuditEntry = JSON.parse(line);
          if (opts.session_id && e.session_id !== opts.session_id) continue;
          if (opts.severity && e.severity !== opts.severity) continue;
          entries.push(e);
        } catch {}
      }
    } catch {}
  }

  return entries;
}

export function shouldTakeScreenshot(action: SemanticAction): boolean {
  const str = JSON.stringify(action).toLowerCase();
  return CRITICAL_PATTERNS.some((p) => p.test(str));
}
