/**
 * Graph Store — persists API graphs to disk, loads them back.
 * Each org+site combination = one JSON file.
 * Path: ~/.sound-browser/graphs/<org_id>/<site_host>.json
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync, writeFileSync } from "fs";
import type { ApiGraph, GraphNode, GraphEdge } from "../graph/types.ts";

const STORE_BASE = join(homedir(), ".sound-browser", "graphs");

function orgDir(orgId: string): string {
  return join(STORE_BASE, orgId);
}

function graphPath(orgId: string, siteHost: string): string {
  const safe = siteHost.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(orgDir(orgId), `${safe}.json`);
}

interface StoredGraph {
  org_id: string;
  site_host: string;
  graph_version: number;
  nodes: [string, GraphNode][];
  edges: GraphEdge[];
  saved_at: string;
  workflow_count: number;
}

export function saveGraph(graph: ApiGraph, workflowCount = 1): void {
  const dir = orgDir(graph.org_id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const stored: StoredGraph = {
    org_id: graph.org_id,
    site_host: graph.site_host,
    graph_version: graph.graph_version,
    nodes: Array.from(graph.nodes.entries()),
    edges: graph.edges,
    saved_at: new Date().toISOString(),
    workflow_count: workflowCount,
  };

  writeFileSync(graphPath(graph.org_id, graph.site_host), JSON.stringify(stored, null, 2), "utf8");
}

export function loadGraph(orgId: string, siteHost: string): ApiGraph | null {
  const path = graphPath(orgId, siteHost);
  if (!existsSync(path)) return null;

  const stored: StoredGraph = JSON.parse(readFileSync(path, "utf8"));
  return {
    org_id: stored.org_id,
    site_host: stored.site_host,
    graph_version: stored.graph_version,
    nodes: new Map(stored.nodes),
    edges: stored.edges,
  };
}

export function listGraphs(orgId?: string): Array<{
  org_id: string;
  site_host: string;
  graph_version: number;
  node_count: number;
  workflow_count: number;
  saved_at: string;
}> {
  const results = [];

  const orgs = orgId
    ? [orgId]
    : (existsSync(STORE_BASE) ? readdirSync(STORE_BASE) : []);

  for (const org of orgs) {
    const dir = orgDir(org);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const stored: StoredGraph = JSON.parse(readFileSync(join(dir, file), "utf8"));
        results.push({
          org_id: stored.org_id,
          site_host: stored.site_host,
          graph_version: stored.graph_version,
          node_count: stored.nodes.length,
          workflow_count: stored.workflow_count,
          saved_at: stored.saved_at,
        });
      } catch { /* skip corrupt */ }
    }
  }

  return results;
}

export function deleteGraph(orgId: string, siteHost: string): boolean {
  const path = graphPath(orgId, siteHost);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function graphExists(orgId: string, siteHost: string): boolean {
  return existsSync(graphPath(orgId, siteHost));
}
