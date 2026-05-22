import type { GraphNode } from "../graph/types.ts";

interface CacheEntry {
  sequence: GraphNode[];
  graph_version: number;
  cached_at: number;
}

// In-memory cache for Phase 1. Phase 2: replace with Redis or Postgres table.
// Key: `${org_id}:${intent_hash}:${graph_version}`
const cache = new Map<string, CacheEntry>();

function intentHash(intent: string): string {
  // Simple deterministic hash — replace with crypto.subtle in production
  let h = 5381;
  for (let i = 0; i < intent.length; i++) {
    h = ((h << 5) + h) ^ intent.charCodeAt(i);
    h = h >>> 0; // convert to unsigned 32-bit int
  }
  return h.toString(16);
}

export function getCachedSequence(
  orgId: string,
  intent: string,
  graphVersion: number,
): GraphNode[] | null {
  const key = `${orgId}:${intentHash(intent)}:${graphVersion}`;
  const entry = cache.get(key);
  if (!entry) return null;
  // Stale if graph_version changed (shouldn't happen with versioned key, but defensive)
  if (entry.graph_version !== graphVersion) {
    cache.delete(key);
    return null;
  }
  return entry.sequence;
}

export function setCachedSequence(
  orgId: string,
  intent: string,
  graphVersion: number,
  sequence: GraphNode[],
): void {
  const key = `${orgId}:${intentHash(intent)}:${graphVersion}`;
  cache.set(key, { sequence, graph_version: graphVersion, cached_at: Date.now() });
}

// Called when the graph is updated — evicts all entries for this org
export function invalidateOrgCache(orgId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${orgId}:`)) {
      cache.delete(key);
    }
  }
}

export function cacheSize(): number {
  return cache.size;
}
