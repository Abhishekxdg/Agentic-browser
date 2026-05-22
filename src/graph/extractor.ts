import type { RecordedWorkflow } from "../recorder/types.ts";
import type { ApiGraph, GraphEdge, GraphNode } from "./types.ts";

export function extractGraph(
  workflow: RecordedWorkflow,
  orgId: string,
  existing?: ApiGraph,
): ApiGraph {
  const siteHost = new URL(workflow.site_url).host;
  const graphVersion = (existing?.graph_version ?? 0) + 1;

  const nodes: Map<string, GraphNode> = new Map(existing?.nodes ?? []);
  const edges: GraphEdge[] = [...(existing?.edges ?? [])];

  for (const endpoint of workflow.endpoints) {
    const id = `${endpoint.method}:${endpoint.url_template}`;
    const existing_node = nodes.get(id);

    nodes.set(id, {
      ...endpoint,
      id,
      site_host: siteHost,
      graph_version: graphVersion,
      // Preserve existing embedding if endpoint hasn't changed structurally
      embedding: existing_node?.embedding,
    });
  }

  // Add sequence edges from workflow ordering
  for (let i = 0; i < workflow.sequence.length - 1; i++) {
    const fromUrl = workflow.sequence[i]!;
    const toUrl = workflow.sequence[i + 1]!;

    // Find a node matching each url_template (method-agnostic for sequence edges)
    const fromId = findNodeId(nodes, fromUrl);
    const toId = findNodeId(nodes, toUrl);

    if (fromId && toId && !edgeExists(edges, fromId!, toId!, "sequence")) {
      edges.push({ from_endpoint_id: fromId!, to_endpoint_id: toId!, edge_type: "sequence" });
    }
  }

  // Add data dependency edges from param_bindings
  for (const endpoint of workflow.endpoints) {
    const toId = `${endpoint.method}:${endpoint.url_template}`;
    for (const binding of endpoint.param_bindings) {
      // Find the source node that produces this extractor field
      const fromId = findNodeWithExtractor(nodes, binding.source_extractor);
      if (fromId && !edgeExists(edges, fromId, toId, "data_dependency")) {
        edges.push({
          from_endpoint_id: fromId,
          to_endpoint_id: toId,
          edge_type: "data_dependency",
          binding_field: binding.source_extractor,
        });
      }
    }
  }

  return { org_id: orgId, site_host: siteHost, graph_version: graphVersion, nodes, edges };
}

function findNodeId(nodes: Map<string, GraphNode>, urlTemplate: string): string | undefined {
  for (const [id, node] of nodes) {
    if (node.url_template === urlTemplate) return id;
  }
  return undefined;
}

function findNodeWithExtractor(nodes: Map<string, GraphNode>, extractorField: string): string | undefined {
  for (const [id, node] of nodes) {
    if (node.output_extractors.some((e) => e.field === extractorField)) return id;
  }
  return undefined;
}

function edgeExists(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
  type: GraphEdge["edge_type"],
): boolean {
  return edges.some(
    (e) => e.from_endpoint_id === fromId && e.to_endpoint_id === toId && e.edge_type === type,
  );
}

export function getSequence(graph: ApiGraph, startUrlTemplate?: string): GraphNode[] {
  const visited = new Set<string>();
  const result: GraphNode[] = [];

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = graph.nodes.get(nodeId);
    if (node) result.push(node);

    // Follow sequence edges
    for (const edge of graph.edges) {
      if (edge.from_endpoint_id === nodeId && edge.edge_type === "sequence") {
        visit(edge.to_endpoint_id);
      }
    }
  }

  if (startUrlTemplate) {
    const startId = findNodeId(graph.nodes, startUrlTemplate);
    if (startId) visit(startId);
  } else {
    // Start from nodes with no incoming sequence edges
    const hasIncoming = new Set(
      graph.edges
        .filter((e) => e.edge_type === "sequence")
        .map((e) => e.to_endpoint_id),
    );
    for (const [id] of graph.nodes) {
      if (!hasIncoming.has(id)) visit(id);
    }
  }

  return result;
}
