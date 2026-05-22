import { describe, it, expect } from "vitest";
import { extractGraph, getSequence } from "./extractor.ts";
import type { RecordedWorkflow } from "../recorder/types.ts";

const mockWorkflow: RecordedWorkflow = {
  name: "submit_invoice",
  site_url: "https://app.invoicing.example.com",
  recorded_at: new Date(),
  sequence: [
    "https://api.invoicing.example.com/v1/invoices",
    "https://api.invoicing.example.com/v1/invoices/:param/line_items",
    "https://api.invoicing.example.com/v1/invoices/:param/submit",
  ],
  endpoints: [
    {
      method: "POST",
      url_template: "https://api.invoicing.example.com/v1/invoices",
      params: [{ name: "customer_id", type: "string", required: true, source: "body" }],
      auth_type: "bearer",
      prerequisite_endpoints: [],
      success_indicators: [201],
      output_extractors: [{ field: "invoice_id", jsonpath: "$.id" }],
      param_bindings: [],
    },
    {
      method: "POST",
      url_template: "https://api.invoicing.example.com/v1/invoices/:param/line_items",
      params: [
        { name: "invoice_id", type: "string", required: true, source: "path" },
        { name: "description", type: "string", required: true, source: "body" },
        { name: "amount", type: "number", required: true, source: "body" },
      ],
      auth_type: "bearer",
      prerequisite_endpoints: ["https://api.invoicing.example.com/v1/invoices"],
      success_indicators: [200],
      output_extractors: [],
      param_bindings: [
        { source_extractor: "invoice_id", target_param: "invoice_id", target_location: "path" },
      ],
    },
    {
      method: "POST",
      url_template: "https://api.invoicing.example.com/v1/invoices/:param/submit",
      params: [{ name: "invoice_id", type: "string", required: true, source: "path" }],
      auth_type: "bearer",
      prerequisite_endpoints: [
        "https://api.invoicing.example.com/v1/invoices",
        "https://api.invoicing.example.com/v1/invoices/:param/line_items",
      ],
      success_indicators: [200],
      output_extractors: [],
      param_bindings: [
        { source_extractor: "invoice_id", target_param: "invoice_id", target_location: "path" },
      ],
    },
  ],
};

describe("extractGraph", () => {
  it("creates graph nodes for all endpoints", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    expect(graph.nodes.size).toBe(3);
  });

  it("assigns correct node IDs", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    expect(graph.nodes.has("POST:https://api.invoicing.example.com/v1/invoices")).toBe(true);
  });

  it("creates sequence edges from workflow ordering", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    const seqEdges = graph.edges.filter((e) => e.edge_type === "sequence");
    expect(seqEdges.length).toBe(2);
  });

  it("creates data dependency edge for invoice_id binding", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    const depEdges = graph.edges.filter((e) => e.edge_type === "data_dependency");
    expect(depEdges.length).toBeGreaterThan(0);
    expect(depEdges[0]?.binding_field).toBe("invoice_id");
  });

  it("increments graph_version on each extraction", () => {
    const graph1 = extractGraph(mockWorkflow, "org-1");
    expect(graph1.graph_version).toBe(1);
    const graph2 = extractGraph(mockWorkflow, "org-1", graph1);
    expect(graph2.graph_version).toBe(2);
  });

  it("preserves existing nodes from prior graph version", () => {
    const graph1 = extractGraph(mockWorkflow, "org-1");
    const graph2 = extractGraph(mockWorkflow, "org-1", graph1);
    expect(graph2.nodes.size).toBe(3);
  });

  it("does not create duplicate sequence edges", () => {
    const graph1 = extractGraph(mockWorkflow, "org-1");
    const graph2 = extractGraph(mockWorkflow, "org-1", graph1);
    const seqEdges = graph2.edges.filter((e) => e.edge_type === "sequence");
    // Should still be 2, not 4
    expect(seqEdges.length).toBe(2);
  });
});

describe("getSequence", () => {
  it("returns nodes in sequence order starting from root", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    const sequence = getSequence(graph);
    expect(sequence.length).toBe(3);
    expect(sequence[0]?.url_template).toBe("https://api.invoicing.example.com/v1/invoices");
  });

  it("returns nodes in sequence order starting from specific url_template", () => {
    const graph = extractGraph(mockWorkflow, "org-1");
    const sequence = getSequence(graph, "https://api.invoicing.example.com/v1/invoices/:param/line_items");
    expect(sequence[0]?.url_template).toBe("https://api.invoicing.example.com/v1/invoices/:param/line_items");
  });
});
