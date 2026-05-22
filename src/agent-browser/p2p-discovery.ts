/**
 * P2P Skill Discovery — Hidden network layer for sharing validated workflows.
 *
 * Design philosophy: P2P is an implementation detail, not a user-facing feature.
 * Agents automatically discover skills from peers. Users see "discovered" skills
 * alongside builtin and marketplace skills. No opt-in, no configuration.
 *
 * Monetization:
 *   • Free tier: P2P discovery + browser execution (slow)
 *   • Pro tier: API replay execution (10-100x faster) + priority P2P lookups
 *   • Enterprise tier: Private P2P ring + skill governance + audit trail
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
 *   │  Local Node │◄───►│  P2P Gossip/DHT  │◄───►│  Peer Node  │
 *   │             │     │  (content-hashed)│     │             │
 *   │ • Local     │     │                  │     │ • Local     │
 *   │   skills    │     │ • Skill announcements│   │   skills    │
 *   │ • Discovered│     │ • Query routing    │   │ • Discovered│
 *   │   skills    │     │ • Reputation       │   │   skills    │
 *   │ • Cache     │     │   aggregation      │   │ • Cache     │
 *   └─────────────┘     └──────────────────┘     └─────────────┘
 *
 * Security:
 *   • Skills are content-addressed (SHA256 of canonical form)
 *   • Credentials are NEVER shared — only workflow graphs and selectors
 *   • Received skills are verified locally before being trusted
 *   • Enterprise: private DHT ring, only org nodes can participate
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import type { Skill, SkillStep } from "./skills.ts";
import { saveSkill, loadSkill } from "./skills.ts";

const P2P_DIR = join(homedir(), ".sound-browser", "p2p");

// ── Types ──────────────────────────────────────────────────────────────────

export interface P2PSkillAnnouncement {
  /** Content-addressed hash of the skill (without credentials). */
  content_hash: string;
  /** Human-readable name. */
  name: string;
  /** Target site, e.g. "zoho.com". */
  site: string;
  /** Intent description, e.g. "create an invoice". */
  intent: string;
  /** Number of successful verified executions on this node. */
  local_verified_count: number;
  /** Reliability score (0-1) based on local success rate. */
  local_reliability: number;
  /** ISO 8601 timestamp of first creation. */
  created_at: string;
  /** ISO 8601 timestamp of last successful execution. */
  last_used_at: string;
  /** Size of the canonical skill JSON in bytes. */
  payload_size: number;
  /** Whether this skill includes an API replay sequence. */
  has_api_replay: boolean;
  /** Minimum tier required. Used for gossip filtering. */
  required_tier?: "free" | "pro" | "enterprise";
}

export interface P2PNetworkState {
  /** Skills we have announced to the network. */
  announced: Map<string, P2PSkillAnnouncement>;
  /** Skills we have received from peers, pending local verification. */
  pending: Map<string, P2PSkillAnnouncement>;
  /** Verified skills we have accepted into local storage. */
  verified: Map<string, P2PSkillAnnouncement>;
  /** Peers we have recently communicated with. */
  known_peers: Set<string>;
  /** Node ID (derived from a persistent key or random). */
  node_id: string;
}

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir() { if (!existsSync(P2P_DIR)) mkdirSync(P2P_DIR, { recursive: true }); }
function statePath() { return join(P2P_DIR, "network-state.json"); }

function loadState(): P2PNetworkState {
  ensureDir();
  const path = statePath();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      announced: new Map(Object.entries(raw.announced ?? {})),
      pending: new Map(Object.entries(raw.pending ?? {})),
      verified: new Map(Object.entries(raw.verified ?? {})),
      known_peers: new Set(raw.known_peers ?? []),
      node_id: raw.node_id ?? generateNodeId(),
    };
  }
  return {
    announced: new Map(),
    pending: new Map(),
    verified: new Map(),
    known_peers: new Set(),
    node_id: generateNodeId(),
  };
}

function saveState(state: P2PNetworkState): void {
  ensureDir();
  writeFileSync(statePath(), JSON.stringify({
    announced: Object.fromEntries(state.announced),
    pending: Object.fromEntries(state.pending),
    verified: Object.fromEntries(state.verified),
    known_peers: Array.from(state.known_peers),
    node_id: state.node_id,
  }, null, 2), "utf8");
}

function generateNodeId(): string {
  const id = createHash("sha256").update(Date.now().toString() + Math.random().toString()).digest("hex").slice(0, 32);
  return id;
}

// ── Content Hashing ────────────────────────────────────────────────────────

/**
 * Compute a content-addressed hash of a skill.
 * Strips volatile fields (use_count, peer_count, timestamps) and credentials.
 */
export function hashSkill(skill: Skill): string {
  const canonical = {
    name: skill.name,
    site: skill.site,
    description: skill.description,
    parameters: skill.parameters.map((p) => ({ name: p.name, type: p.type, required: p.required, description: p.description })),
    steps: skill.steps.map((s) => ({ description: s.description, actions: s.actions.map((a) => {
      // Strip filled values — keep the action shape only
      const { value, ...rest } = a as Record<string, unknown>;
      return rest;
    }) })),
    auth_required: skill.auth_required,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ── Announcement ───────────────────────────────────────────────────────────

/**
 * Announce a locally-created or verified skill to the P2P network.
 * Called automatically after a skill achieves a reliability threshold.
 */
export function announceSkill(skill: Skill): P2PSkillAnnouncement {
  const state = loadState();
  const hash = skill.content_hash ?? hashSkill(skill);

  const announcement: P2PSkillAnnouncement = {
    content_hash: hash,
    name: skill.name,
    site: skill.site,
    intent: skill.description,
    local_verified_count: skill.network_verified_count ?? skill.use_count ?? 1,
    local_reliability: skill.reliability ?? 0.5,
    created_at: skill.created_at,
    last_used_at: skill.last_synced_at ?? new Date().toISOString(),
    payload_size: JSON.stringify(skill).length,
    has_api_replay: skill.has_api_replay ?? false,
    required_tier: skill.required_tier ?? "free",
  };

  state.announced.set(hash, announcement);
  saveState(state);

  // TODO: In a real implementation, broadcast to DHT/WebRTC peers here.
  // For now, this is a local-only stub that prepares the data structure.

  return announcement;
}

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Query the local cache and (stub) the network for skills matching a site.
 * Returns candidates sorted by network reliability score.
 */
export function discoverSkills(site: string, userTier: "free" | "pro" | "enterprise" = "free"): P2PSkillAnnouncement[] {
  const state = loadState();
  const candidates: P2PSkillAnnouncement[] = [];

  // Check local verified cache
  for (const [, ann] of state.verified) {
    if (ann.site === site || ann.site.includes(site)) {
      candidates.push(ann);
    }
  }

  // Check pending (not yet verified but announced by peers)
  for (const [, ann] of state.pending) {
    if ((ann.site === site || ann.site.includes(site)) && isTierAllowed(ann.required_tier, userTier)) {
      candidates.push(ann);
    }
  }

  // Sort by reliability * peer_count proxy (network consensus)
  return candidates.sort((a, b) => {
    const scoreA = a.local_reliability * (a.local_verified_count + 1);
    const scoreB = b.local_reliability * (b.local_verified_count + 1);
    return scoreB - scoreA;
  });
}

function isTierAllowed(skillTier: "free" | "pro" | "enterprise" | undefined, userTier: "free" | "pro" | "enterprise"): boolean {
  const rank = { free: 0, pro: 1, enterprise: 2 };
  return rank[userTier] >= rank[skillTier ?? "free"];
}

// ── Verification ───────────────────────────────────────────────────────────

/**
 * Accept a pending skill into local storage after local verification.
 * This is the critical trust boundary — we never trust peers blindly.
 */
export function verifyAndImportSkill(hash: string, skillPayload: Skill): Skill | null {
  const state = loadState();
  const pending = state.pending.get(hash);
  if (!pending) return null;

  // Verify hash matches
  const computed = hashSkill(skillPayload);
  if (computed !== hash) {
    console.warn(`[P2P] Hash mismatch for skill ${skillPayload.name}: expected ${hash}, got ${computed}`);
    return null;
  }

  // Mark as verified
  state.verified.set(hash, pending);
  state.pending.delete(hash);
  saveState(state);

  // Save to local skill store
  const imported: Skill = {
    ...skillPayload,
    source: "discovered",
    content_hash: hash,
    peer_count: 1, // first peer
    network_verified_count: pending.local_verified_count,
    last_synced_at: new Date().toISOString(),
  };
  saveSkill(imported);

  return imported;
}

// ── Reputation ───────────────────────────────────────────────────────────

/**
 * Report a skill execution result back to the P2P layer.
 * Positive results increase reliability; negative results are logged.
 */
export function reportExecution(skillName: string, success: boolean): void {
  const skill = loadSkill(skillName);
  if (!skill || skill.source !== "discovered") return;

  const state = loadState();
  const hash = skill.content_hash ?? hashSkill(skill);
  const ann = state.verified.get(hash) ?? state.announced.get(hash);

  if (ann) {
    if (success) {
      ann.local_verified_count++;
      // Exponential moving average for reliability
      ann.local_reliability = ann.local_reliability * 0.9 + 1.0 * 0.1;
    } else {
      ann.local_reliability = ann.local_reliability * 0.9 + 0.0 * 0.1;
    }
    ann.last_used_at = new Date().toISOString();
    saveState(state);
  }

  // If reliability drops below threshold, consider re-announcing to warn peers
  if (!success && ann && ann.local_reliability < 0.3) {
    console.warn(`[P2P] Skill ${skillName} reliability dropped to ${ann.local_reliability.toFixed(2)}`);
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────

export function getP2PStats(): {
  announced: number;
  pending: number;
  verified: number;
  peers: number;
  node_id: string;
} {
  const state = loadState();
  return {
    announced: state.announced.size,
    pending: state.pending.size,
    verified: state.verified.size,
    peers: state.known_peers.size,
    node_id: state.node_id,
  };
}

// ── Stub: Network transport hooks ──────────────────────────────────────────
// These would be implemented with libp2p, WebRTC, or a lightweight gossip protocol.

export function startP2PListener(): void {
  // TODO: Initialize WebRTC / libp2p node, join DHT, listen for announcements.
  console.log("[P2P] Discovery layer initialized (stub). Network transport not yet connected.");
}

export function stopP2PListener(): void {
  // TODO: Close connections, persist final state.
  console.log("[P2P] Discovery layer stopped.");
}
