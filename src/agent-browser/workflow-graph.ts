/**
 * Workflow Graph Engine — represents workflows as executable DAGs.
 * Login → Navigate → Search → Filter → Purchase → Verify
 * Enables: retries per node, resumability from any checkpoint, optimization.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import type { BrowserSession } from "./session-manager.ts";
import { executeAction, refreshPageModel } from "./session-manager.ts";
import type { SemanticAction } from "./action-resolver.ts";

const WORKFLOWS_DIR = join(homedir(), ".agent-browser", "workflows");

export type NodeStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkflowNode {
  id: string;
  label: string;
  description: string;
  expected_outcome: string;
  actions: SemanticAction[];
  depends_on: string[];          // node IDs that must complete first
  max_retries: number;
  checkpoint: boolean;           // save state after this node
  optional: boolean;             // skip on failure and continue
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: "always" | "on_success" | "on_failure";
}

export interface WorkflowGraph {
  id: string;
  name: string;
  site: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  created_at: string;
  version: number;
}

export interface WorkflowRun {
  id: string;
  graph_id: string;
  status: "running" | "done" | "failed" | "paused";
  current_node?: string;
  node_statuses: Record<string, NodeStatus>;
  node_results: Record<string, { success: boolean; error?: string; retries: number }>;
  started_at: string;
  finished_at?: string;
  error?: string;
}

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(WORKFLOWS_DIR)) mkdirSync(WORKFLOWS_DIR, { recursive: true });
}

function graphPath(id: string) { return join(WORKFLOWS_DIR, `${id}.json`); }
function runPath(id: string)   { return join(WORKFLOWS_DIR, `run-${id}.json`); }

export function saveWorkflow(graph: WorkflowGraph): void {
  ensureDir();
  writeFileSync(graphPath(graph.id), JSON.stringify(graph, null, 2), "utf8");
}

export function loadWorkflow(id: string): WorkflowGraph | null {
  const p = graphPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function listWorkflows(): Array<{ id: string; name: string; site: string; nodes: number }> {
  ensureDir();
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("run-"))
    .map((f) => {
      try {
        const g: WorkflowGraph = JSON.parse(readFileSync(join(WORKFLOWS_DIR, f), "utf8"));
        return { id: g.id, name: g.name, site: g.site, nodes: g.nodes.length };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{ id: string; name: string; site: string; nodes: number }>;
}

// ── Topology ───────────────────────────────────────────────────────────────

function topologicalOrder(graph: WorkflowGraph): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodeMap.get(id);
    if (node) {
      for (const dep of node.depends_on) visit(dep);
      result.push(id);
    }
  }

  for (const node of graph.nodes) visit(node.id);
  return result;
}

function getReadyNodes(graph: WorkflowGraph, statuses: Record<string, NodeStatus>): WorkflowNode[] {
  return graph.nodes.filter((node) => {
    if (statuses[node.id] && statuses[node.id] !== "pending") return false;
    return node.depends_on.every((dep) => statuses[dep] === "done" || statuses[dep] === "skipped");
  });
}

// ── Execution ──────────────────────────────────────────────────────────────

async function executeNode(
  session: BrowserSession,
  node: WorkflowNode,
  run: WorkflowRun,
): Promise<boolean> {
  run.node_statuses[node.id] = "running";
  run.current_node = node.id;
  let retries = 0;

  while (retries <= node.max_retries) {
    let allSuccess = true;
    let lastError: string | undefined;

    for (const action of node.actions) {
      const result = await executeAction(session, action);
      if (!result.success) {
        allSuccess = false;
        lastError = result.error;
        break;
      }
      // Small settle between actions
      await new Promise((r) => setTimeout(r, 200));
    }

    if (allSuccess) {
      run.node_statuses[node.id] = "done";
      run.node_results[node.id] = { success: true, retries };
      return true;
    }

    retries++;
    if (retries <= node.max_retries) {
      await new Promise((r) => setTimeout(r, 1000 * retries));
    } else {
      run.node_statuses[node.id] = node.optional ? "skipped" : "failed";
      run.node_results[node.id] = { success: false, error: lastError, retries };
      return node.optional;
    }
  }

  return false;
}

export async function executeWorkflow(
  session: BrowserSession,
  graphId: string,
  resumeFrom?: string,
  onNodeComplete?: (nodeId: string, status: NodeStatus) => void,
): Promise<WorkflowRun> {
  const graph = loadWorkflow(graphId);
  if (!graph) throw new Error(`Workflow ${graphId} not found`);

  const runId = `${graphId}-${Date.now()}`;
  const run: WorkflowRun = {
    id: runId,
    graph_id: graphId,
    status: "running",
    node_statuses: {},
    node_results: {},
    started_at: new Date().toISOString(),
  };

  // Initialize all node statuses
  for (const node of graph.nodes) {
    run.node_statuses[node.id] = "pending";
  }

  // If resuming, mark completed nodes as done
  if (resumeFrom) {
    const order = topologicalOrder(graph);
    for (const id of order) {
      if (id === resumeFrom) break;
      run.node_statuses[id] = "done";
      run.node_results[id] = { success: true, retries: 0 };
    }
  }

  // Execute in topological order, respecting dependencies
  const order = topologicalOrder(graph);
  for (const nodeId of order) {
    if (run.node_statuses[nodeId] === "done") continue; // already done (resume)

    const node = graph.nodes.find((n) => n.id === nodeId)!;

    // Check if dependencies are met
    const depsMet = node.depends_on.every((dep) =>
      run.node_statuses[dep] === "done" || run.node_statuses[dep] === "skipped"
    );
    if (!depsMet) {
      run.node_statuses[nodeId] = "skipped";
      continue;
    }

    const success = await executeNode(session, node, run);
    onNodeComplete?.(nodeId, run.node_statuses[nodeId]);

    if (!success && !node.optional) {
      run.status = "failed";
      run.error = `Failed at node: ${node.label}`;
      run.finished_at = new Date().toISOString();
      writeFileSync(runPath(runId), JSON.stringify(run, null, 2), "utf8");
      return run;
    }
  }

  run.status = Object.values(run.node_statuses).every((s) => s === "done" || s === "skipped") ? "done" : "failed";
  run.finished_at = new Date().toISOString();
  writeFileSync(runPath(runId), JSON.stringify(run, null, 2), "utf8");
  return run;
}

// ── Builder helpers ────────────────────────────────────────────────────────

export function buildWorkflow(name: string, site: string): {
  node(id: string, label: string, actions: SemanticAction[], opts?: Partial<Omit<WorkflowNode, "id" | "label" | "actions">>): ReturnType<typeof buildWorkflow>;
  edge(from: string, to: string, condition?: WorkflowEdge["condition"]): ReturnType<typeof buildWorkflow>;
  save(): WorkflowGraph;
} {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const id = `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;

  const builder = {
    node(nodeId: string, label: string, actions: SemanticAction[], opts: Partial<Omit<WorkflowNode, "id" | "label" | "actions">> = {}) {
      nodes.push({
        id: nodeId,
        label,
        description: opts.description ?? label,
        expected_outcome: opts.expected_outcome ?? "",
        actions,
        depends_on: opts.depends_on ?? (nodes.length > 0 ? [nodes[nodes.length - 1].id] : []),
        max_retries: opts.max_retries ?? 2,
        checkpoint: opts.checkpoint ?? false,
        optional: opts.optional ?? false,
      });
      return builder;
    },
    edge(from: string, to: string, condition: WorkflowEdge["condition"] = "always") {
      edges.push({ from, to, condition });
      return builder;
    },
    save(): WorkflowGraph {
      const graph: WorkflowGraph = { id, name, site, nodes, edges, created_at: new Date().toISOString(), version: 1 };
      saveWorkflow(graph);
      return graph;
    },
  };

  return builder;
}
