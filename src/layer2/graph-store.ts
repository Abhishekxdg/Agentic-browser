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
const bunSql = (globalThis as any).Bun?.sql as undefined | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>);
const DATABASE_URL = process.env.SOUND_DATABASE_URL ?? process.env.DATABASE_URL;
const configuredBackend = process.env.SOUND_GRAPH_BACKEND ?? process.env.AGENT_GRAPH_BACKEND;
let postgresEnabled = (configuredBackend === "postgres" || (!configuredBackend && !!DATABASE_URL)) && !!bunSql;
let pgInitialized = false;

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

async function ensurePostgresReady(): Promise<void> {
  if (!postgresEnabled || pgInitialized || !bunSql) return;
  try {
    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_graphs (
        org_id TEXT NOT NULL,
        site_host TEXT NOT NULL,
        graph_version INTEGER NOT NULL,
        workflow_count INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (org_id, site_host)
      )
    `;
    pgInitialized = true;
  } catch (err) {
    postgresEnabled = false;
    console.warn(`[graphs] Postgres init failed, using file backend: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function toStored(graph: ApiGraph, workflowCount: number): StoredGraph {
  return {
    org_id: graph.org_id,
    site_host: graph.site_host,
    graph_version: graph.graph_version,
    nodes: Array.from(graph.nodes.entries()),
    edges: graph.edges,
    saved_at: new Date().toISOString(),
    workflow_count: workflowCount,
  };
}

function fromStored(stored: StoredGraph): ApiGraph {
  return {
    org_id: stored.org_id,
    site_host: stored.site_host,
    graph_version: stored.graph_version,
    nodes: new Map(stored.nodes),
    edges: stored.edges,
  };
}

export async function saveGraph(graph: ApiGraph, workflowCount = 1): Promise<void> {
  const stored = toStored(graph, workflowCount);
  if (postgresEnabled && bunSql) {
    await ensurePostgresReady();
    if (postgresEnabled) {
      await bunSql`
        INSERT INTO sound_graphs (org_id, site_host, graph_version, workflow_count, saved_at, payload)
        VALUES (${stored.org_id}, ${stored.site_host}, ${stored.graph_version}, ${stored.workflow_count}, ${stored.saved_at}, ${JSON.stringify(stored)})
        ON CONFLICT (org_id, site_host) DO UPDATE SET
          graph_version = excluded.graph_version,
          workflow_count = excluded.workflow_count,
          saved_at = excluded.saved_at,
          payload = excluded.payload
      `;
      return;
    }
  }

  const dir = orgDir(graph.org_id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(graphPath(graph.org_id, graph.site_host), JSON.stringify(stored, null, 2), "utf8");
}

export async function loadGraph(orgId: string, siteHost: string): Promise<ApiGraph | null> {
  if (postgresEnabled && bunSql) {
    await ensurePostgresReady();
    if (postgresEnabled) {
      const rows = await bunSql`SELECT payload FROM sound_graphs WHERE org_id = ${orgId} AND site_host = ${siteHost} LIMIT 1`;
      const first = rows[0];
      if (!first || typeof first.payload !== "string") return null;
      const stored = JSON.parse(first.payload) as StoredGraph;
      return fromStored(stored);
    }
  }

  const path = graphPath(orgId, siteHost);
  if (!existsSync(path)) return null;
  const stored: StoredGraph = JSON.parse(readFileSync(path, "utf8"));
  return fromStored(stored);
}

export async function listGraphs(orgId?: string): Promise<Array<{
  org_id: string;
  site_host: string;
  graph_version: number;
  node_count: number;
  workflow_count: number;
  saved_at: string;
}>> {
  if (postgresEnabled && bunSql) {
    await ensurePostgresReady();
    if (postgresEnabled) {
      const rows = orgId
        ? await bunSql`SELECT payload FROM sound_graphs WHERE org_id = ${orgId} ORDER BY saved_at DESC`
        : await bunSql`SELECT payload FROM sound_graphs ORDER BY saved_at DESC`;
      const results: Array<{ org_id: string; site_host: string; graph_version: number; node_count: number; workflow_count: number; saved_at: string }> = [];
      for (const row of rows) {
        if (typeof row.payload !== "string") continue;
        try {
          const stored = JSON.parse(row.payload) as StoredGraph;
          results.push({
            org_id: stored.org_id,
            site_host: stored.site_host,
            graph_version: stored.graph_version,
            node_count: stored.nodes.length,
            workflow_count: stored.workflow_count,
            saved_at: stored.saved_at,
          });
        } catch {
          // skip corrupt rows
        }
      }
      return results;
    }
  }

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

export async function deleteGraph(orgId: string, siteHost: string): Promise<boolean> {
  if (postgresEnabled && bunSql) {
    await ensurePostgresReady();
    if (postgresEnabled) {
      const rows = await bunSql`DELETE FROM sound_graphs WHERE org_id = ${orgId} AND site_host = ${siteHost} RETURNING org_id`;
      return rows.length > 0;
    }
  }

  const path = graphPath(orgId, siteHost);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export async function graphExists(orgId: string, siteHost: string): Promise<boolean> {
  if (postgresEnabled && bunSql) {
    await ensurePostgresReady();
    if (postgresEnabled) {
      const rows = await bunSql`SELECT org_id FROM sound_graphs WHERE org_id = ${orgId} AND site_host = ${siteHost} LIMIT 1`;
      return rows.length > 0;
    }
  }
  return existsSync(graphPath(orgId, siteHost));
}

export function getGraphBackend(): { backend: "postgres" | "file"; postgres_ready: boolean } {
  return { backend: postgresEnabled ? "postgres" : "file", postgres_ready: pgInitialized };
}
