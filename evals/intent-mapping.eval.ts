/**
 * Feasibility Gate Eval
 *
 * Run before building the execution engine or SDK.
 * Measures whether the LLM semantic intent mapper hits >80% accuracy
 * on held-out intents for 3 target sites.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun run evals/intent-mapping.eval.ts
 *
 * Output:
 *   Per-site accuracy + overall pass/fail verdict.
 */

import type { ApiGraph } from "../src/graph/types.ts";
import type { GraphNode } from "../src/graph/types.ts";

interface EvalCase {
  intent: string;
  expected_sequence: string[]; // ordered url_templates
}

interface EvalSite {
  name: string;
  graph: ApiGraph;
  cases: EvalCase[];
}

// Resolve intent to API sequence using Claude claude-sonnet-4-6 via function calling
async function resolveIntentWithLLM(
  intent: string,
  graph: ApiGraph,
): Promise<string[]> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const endpoints = Array.from(graph.nodes.values()).map((n) => ({
    id: n.id,
    method: n.method,
    url_template: n.url_template,
    params: n.params,
    output_extractors: n.output_extractors,
    success_indicators: n.success_indicators,
  }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      tools: [
        {
          name: "select_api_sequence",
          description: "Select the ordered sequence of API endpoints that fulfill the given user intent",
          input_schema: {
            type: "object",
            properties: {
              sequence: {
                type: "array",
                items: { type: "string" },
                description: "Ordered list of endpoint IDs (method:url_template) to execute",
              },
              reasoning: {
                type: "string",
                description: "Brief explanation of why this sequence was chosen",
              },
            },
            required: ["sequence"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "select_api_sequence" },
      messages: [
        {
          role: "user",
          content: `You are an API sequence planner. Given a user intent and available API endpoints, select the minimal ordered sequence of endpoints that fulfills the intent.

User intent: "${intent}"

Available endpoints:
${JSON.stringify(endpoints, null, 2)}

Select the endpoint IDs in the correct execution order. Only include endpoints necessary for this specific intent.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} — ${error}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; name?: string; input?: { sequence?: string[] } }>;
  };
  const toolUse = data.content.find((c) => c.type === "tool_use" && c.name === "select_api_sequence");
  return toolUse?.input?.sequence ?? [];
}

function sequenceMatches(predicted: string[], expected: string[]): boolean {
  if (predicted.length !== expected.length) return false;
  // Match on url_template (strip method prefix for flexibility)
  const normalize = (id: string) => id.split(":").slice(1).join(":");
  return predicted.every((p, i) => normalize(p) === normalize(expected[i] ?? ""));
}

async function runEval(site: EvalSite): Promise<{ site: string; accuracy: number; results: Array<{ intent: string; pass: boolean }> }> {
  const results: Array<{ intent: string; pass: boolean; predicted: string[]; expected: string[] }> = [];

  for (const evalCase of site.cases) {
    try {
      const predicted = await resolveIntentWithLLM(evalCase.intent, site.graph);
      const pass = sequenceMatches(predicted, evalCase.expected_sequence);
      results.push({ intent: evalCase.intent, pass, predicted, expected: evalCase.expected_sequence });

      console.log(`  [${pass ? "PASS" : "FAIL"}] "${evalCase.intent}"`);
      if (!pass) {
        console.log(`    expected: ${evalCase.expected_sequence.join(" → ")}`);
        console.log(`    got:      ${predicted.join(" → ")}`);
      }
    } catch (err) {
      console.error(`  [ERROR] "${evalCase.intent}": ${err}`);
      results.push({ intent: evalCase.intent, pass: false, predicted: [], expected: evalCase.expected_sequence });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const accuracy = passed / results.length;
  return { site: site.name, accuracy, results };
}

// ────────────────────────────────────────────────────────────────────────────
// EVAL FIXTURES — replace with real recorded workflows before running
// ────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_SITES: EvalSite[] = [
  {
    name: "Example Invoicing App (placeholder)",
    graph: {
      org_id: "eval-org",
      site_host: "api.invoicing.example.com",
      graph_version: 1,
      nodes: new Map([
        ["POST:https://api.invoicing.example.com/v1/invoices", {
          id: "POST:https://api.invoicing.example.com/v1/invoices",
          method: "POST",
          url_template: "https://api.invoicing.example.com/v1/invoices",
          params: [{ name: "customer_id", type: "string", required: true, source: "body" }],
          auth_type: "bearer",
          prerequisite_endpoints: [],
          success_indicators: [201],
          output_extractors: [{ field: "invoice_id", jsonpath: "$.id" }],
          param_bindings: [],
          site_host: "api.invoicing.example.com",
          graph_version: 1,
        } as GraphNode],
        ["POST:https://api.invoicing.example.com/v1/invoices/:param/submit", {
          id: "POST:https://api.invoicing.example.com/v1/invoices/:param/submit",
          method: "POST",
          url_template: "https://api.invoicing.example.com/v1/invoices/:param/submit",
          params: [{ name: "invoice_id", type: "string", required: true, source: "path" }],
          auth_type: "bearer",
          prerequisite_endpoints: ["https://api.invoicing.example.com/v1/invoices"],
          success_indicators: [200],
          output_extractors: [],
          param_bindings: [{ source_extractor: "invoice_id", target_param: "invoice_id", target_location: "path" }],
          site_host: "api.invoicing.example.com",
          graph_version: 1,
        } as GraphNode],
      ]),
      edges: [
        { from_endpoint_id: "POST:https://api.invoicing.example.com/v1/invoices", to_endpoint_id: "POST:https://api.invoicing.example.com/v1/invoices/:param/submit", edge_type: "sequence" },
      ],
    },
    cases: [
      {
        intent: "create and submit an invoice",
        expected_sequence: [
          "POST:https://api.invoicing.example.com/v1/invoices",
          "POST:https://api.invoicing.example.com/v1/invoices/:param/submit",
        ],
      },
      {
        intent: "submit invoice for customer",
        expected_sequence: [
          "POST:https://api.invoicing.example.com/v1/invoices",
          "POST:https://api.invoicing.example.com/v1/invoices/:param/submit",
        ],
      },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Feasibility Gate Eval ===\n");
  console.log("IMPORTANT: Replace PLACEHOLDER_SITES with real recorded workflows");
  console.log("before using this eval to make the go/no-go decision.\n");

  const TARGET_ACCURACY = 0.80;
  const siteResults: Array<{ site: string; accuracy: number }> = [];

  for (const site of PLACEHOLDER_SITES) {
    console.log(`Site: ${site.name}`);
    const result = await runEval(site);
    siteResults.push({ site: result.site, accuracy: result.accuracy });
    console.log(`  Accuracy: ${(result.accuracy * 100).toFixed(1)}%\n`);
  }

  const overallAccuracy = siteResults.reduce((sum, r) => sum + r.accuracy, 0) / siteResults.length;
  const pass = overallAccuracy >= TARGET_ACCURACY;

  console.log("=== Results ===");
  for (const r of siteResults) {
    const status = r.accuracy >= TARGET_ACCURACY ? "PASS" : "FAIL";
    console.log(`  [${status}] ${r.site}: ${(r.accuracy * 100).toFixed(1)}%`);
  }
  console.log(`\nOverall: ${(overallAccuracy * 100).toFixed(1)}% (target: ${TARGET_ACCURACY * 100}%)`);
  console.log(`Feasibility Gate: ${pass ? "PASS — proceed to build" : "FAIL — rethink semantic mapper before building platform"}`);

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
