/**
 * RBAC — Role-Based Access Control for agent operations.
 * Agent scopes: can read Gmail, cannot send, can draft only.
 * Deny always overrides allow. Wildcard "*" grants everything not denied.
 * Stored at ~/.sound-browser/policies/<org_id>/<agent_id>.json
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";

const POLICIES_DIR = join(homedir(), ".sound-browser", "policies");

// All grantable permissions
export type Permission =
  | "navigate"
  | "read_page"       // getPage, screenshot
  | "click"
  | "fill"
  | "submit"
  | "evaluate_js"
  | "run_skill"
  | "use_vault"
  | "configure_auth"
  | "run_agent"       // /run, /plan endpoints
  | "manage_jobs"
  | "read_audit"
  | "*";              // grants everything not in deny list

export interface AgentPolicy {
  agent_id: string;
  org_id: string;
  display_name?: string;
  allow: Permission[];
  deny: Permission[];
  allowed_sites?: string[];   // host patterns: "github.com", "*.google.com"
  denied_sites?: string[];
  max_sessions?: number;
  rate_limit?: { requests_per_minute: number };
  created_at: string;
  created_by?: string;
}

export interface PermissionCheck {
  allowed: boolean;
  reason: string;
}

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir(orgId: string) {
  const dir = join(POLICIES_DIR, orgId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function policyPath(orgId: string, agentId: string) {
  return join(POLICIES_DIR, orgId, `${agentId}.json`);
}

export function savePolicy(policy: AgentPolicy): void {
  ensureDir(policy.org_id);
  writeFileSync(policyPath(policy.org_id, policy.agent_id), JSON.stringify(policy, null, 2), "utf8");
}

export function loadPolicy(orgId: string, agentId: string): AgentPolicy | null {
  const p = policyPath(orgId, agentId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

export function listPolicies(orgId: string): AgentPolicy[] {
  const dir = join(POLICIES_DIR, orgId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")) as AgentPolicy; } catch { return null; } })
    .filter(Boolean) as AgentPolicy[];
}

export function deletePolicy(orgId: string, agentId: string): boolean {
  const p = policyPath(orgId, agentId);
  if (!existsSync(p)) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

// ── Site matching ──────────────────────────────────────────────────────────

function matchesSitePattern(url: string, pattern: string): boolean {
  try {
    const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return host.endsWith(`.${suffix}`);  // *.google.com matches sub.google.com, NOT google.com
    }
    return host === pattern;
  } catch {
    return url.includes(pattern);
  }
}

function siteAllowed(policy: AgentPolicy, site?: string): PermissionCheck {
  if (!site) return { allowed: true, reason: "no site constraint" };

  if (policy.denied_sites?.some((p) => matchesSitePattern(site, p))) {
    return { allowed: false, reason: `site ${site} is in denied_sites` };
  }
  if (policy.allowed_sites && policy.allowed_sites.length > 0) {
    if (!policy.allowed_sites.some((p) => matchesSitePattern(site, p))) {
      return { allowed: false, reason: `site ${site} not in allowed_sites` };
    }
  }
  return { allowed: true, reason: "site allowed" };
}

// ── Permission check ───────────────────────────────────────────────────────

/**
 * Check if an agent policy allows a given permission on an optional site.
 * Deny always overrides allow. Wildcard "*" in allow grants everything not denied.
 */
export function checkPermission(
  policy: AgentPolicy,
  permission: Permission,
  site?: string,
): PermissionCheck {
  // Site check first
  const sc = siteAllowed(policy, site);
  if (!sc.allowed) return sc;

  // Explicit deny
  if (policy.deny.includes(permission) || policy.deny.includes("*")) {
    return { allowed: false, reason: `permission "${permission}" is explicitly denied` };
  }

  // Explicit allow or wildcard
  if (policy.allow.includes("*") || policy.allow.includes(permission)) {
    return { allowed: true, reason: `permission "${permission}" is allowed` };
  }

  return { allowed: false, reason: `permission "${permission}" not in allow list` };
}

// ── Permission → action type mapping ──────────────────────────────────────

export function actionTypeToPermission(actionType: string): Permission {
  switch (actionType) {
    case "navigate":                  return "navigate";
    case "click":
    case "click_text":
    case "click_selector":
    case "handle_dialog":             return "click";
    case "fill":
    case "fill_selector":             return "fill";
    case "press":
    case "scroll":                    return "click";
    case "evaluate":
    case "evaluate_js":               return "evaluate_js";
    case "wait":                      return "read_page";
    default:                          return "click";
  }
}

// ── Built-in preset policies ───────────────────────────────────────────────

export const PRESET_POLICIES: Record<string, Pick<AgentPolicy, "allow" | "deny" | "display_name">> = {
  "read-only": {
    display_name: "Read-only agent",
    allow: ["navigate", "read_page"],
    deny: ["click", "fill", "submit", "evaluate_js", "run_skill", "use_vault", "configure_auth", "run_agent", "manage_jobs"],
  },
  "read-and-click": {
    display_name: "Read + navigate + click (no form fill)",
    allow: ["navigate", "read_page", "click"],
    deny: ["fill", "submit", "evaluate_js", "use_vault", "configure_auth", "run_agent"],
  },
  "form-fill": {
    display_name: "Full form automation (no JS eval, no vault)",
    allow: ["navigate", "read_page", "click", "fill", "submit", "run_skill"],
    deny: ["evaluate_js", "use_vault", "configure_auth"],
  },
  "full-access": {
    display_name: "Full access (internal/trusted agents only)",
    allow: ["*"],
    deny: [],
  },
};

export function createPolicyFromPreset(
  agentId: string,
  orgId: string,
  preset: keyof typeof PRESET_POLICIES,
  overrides: Partial<AgentPolicy> = {},
): AgentPolicy {
  const base = PRESET_POLICIES[preset];
  if (!base) throw new Error(`Unknown preset: ${preset}`);
  return {
    agent_id: agentId,
    org_id: orgId,
    display_name: base.display_name,
    allow: base.allow,
    deny: base.deny,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Rate limiting (in-memory, per agent) ──────────────────────────────────

const _rateLimitCounters = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(policy: AgentPolicy): PermissionCheck {
  if (!policy.rate_limit) return { allowed: true, reason: "no rate limit" };

  const key = `${policy.org_id}:${policy.agent_id}`;
  const now = Date.now();
  const windowMs = 60_000;
  const entry = _rateLimitCounters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    _rateLimitCounters.set(key, { count: 1, windowStart: now });
    return { allowed: true, reason: "rate limit ok" };
  }

  entry.count++;
  if (entry.count > policy.rate_limit.requests_per_minute) {
    return { allowed: false, reason: `rate limit exceeded (${policy.rate_limit.requests_per_minute} req/min)` };
  }
  return { allowed: true, reason: "rate limit ok" };
}
