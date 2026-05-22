import type { Endpoint } from "../recorder/types.ts";

export interface GraphNode extends Endpoint {
  id: string; // `${method}:${url_template}`
  site_host: string;
  embedding?: number[];  // pgvector — populated after indexing
  graph_version: number;
}

export interface GraphEdge {
  from_endpoint_id: string;
  to_endpoint_id: string;
  edge_type: "sequence" | "data_dependency";
  binding_field?: string; // for data_dependency edges
}

export interface ApiGraph {
  org_id: string;
  site_host: string;
  graph_version: number;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}
