/**
 * Intent Resolver — maps natural language intent → ordered API sequence.
 *
 * Uses an LLM to reason over the API graph and return the right sequence.
 * Supports Gemini (default, uses GEMINI_API_KEY) or OpenAI (OPENAI_API_KEY).
 *
 * Falls back to keyword matching if no LLM is configured — works for simple cases.
 */

import type { ApiGraph, GraphNode } from "../graph/types.ts";
import type { IntentResolver } from "../executor/engine.ts";

export type LLMProvider = "gemini" | "openai" | "keyword";

export function createIntentResolver(provider?: LLMProvider): IntentResolver {
  const p = provider ?? detectProvider();
  switch (p) {
    case "gemini":  return geminiResolver();
    case "openai":  return openaiResolver();
    default:        return keywordResolver();
  }
}

function detectProvider(): LLMProvider {
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "keyword";
}

// ── Shared prompt ──────────────────────────────────────────────────────────

function buildPrompt(intent: string, graph: ApiGraph): string {
  const nodes = Array.from(graph.nodes.values());
  const nodeDescriptions = nodes.map((n) => {
    const params = n.params.map((p) => `${p.name}(${p.type},${p.source})`).join(", ");
    const extractors = n.output_extractors.map((e) => `→${e.field}`).join(", ");
    return `- ID: ${n.id}\n  ${n.method} ${n.url_template}\n  params: [${params}]\n  outputs: [${extractors}]`;
  }).join("\n");

  const edges = graph.edges.map((e) =>
    `  ${e.from_endpoint_id} --${e.edge_type}${e.binding_field ? `(${e.binding_field})` : ""}--> ${e.to_endpoint_id}`
  ).join("\n");

  return `You are an API sequence planner for the site ${graph.site_host}.

Given the API graph below and a user intent, return ONLY a JSON array of endpoint IDs in the exact order they should be called to accomplish the intent.

Rules:
- Include only the endpoints needed for this specific intent
- Respect data dependencies (if endpoint B needs output from endpoint A, put A first)
- If the intent cannot be accomplished with the available endpoints, return []
- Return ONLY valid JSON, no explanation

API Graph nodes:
${nodeDescriptions}

Graph edges:
${edges}

User intent: "${intent}"

Response (JSON array of endpoint IDs only):`;
}

function parseSequence(text: string, graph: ApiGraph): GraphNode[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const ids: string[] = JSON.parse(match[0]);
    return ids
      .map((id) => graph.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  } catch {
    return [];
  }
}

// ── Gemini resolver ────────────────────────────────────────────────────────

function geminiResolver(): IntentResolver {
  return async (intent, graph) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return keywordResolver()(intent, graph);

    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(intent, graph) }] }],
        generation_config: { temperature: 0.0, max_output_tokens: 512 },
      }),
    });

    if (!res.ok) return keywordResolver()(intent, graph);
    const data = await res.json() as any;
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
    return parseSequence(text, graph);
  };
}

// ── OpenAI resolver ────────────────────────────────────────────────────────

function openaiResolver(): IntentResolver {
  return async (intent, graph) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return keywordResolver()(intent, graph);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        messages: [{ role: "user", content: buildPrompt(intent, graph) }],
      }),
    });

    if (!res.ok) return keywordResolver()(intent, graph);
    const data = await res.json() as any;
    const text: string = data.choices?.[0]?.message?.content ?? "[]";
    return parseSequence(text, graph);
  };
}

// ── Keyword fallback ───────────────────────────────────────────────────────
// Simple scoring: match intent words against endpoint URL templates and params.
// Good enough for well-named endpoints; upgrade to LLM for complex cases.

function keywordResolver(): IntentResolver {
  return async (intent, graph) => {
    const intentWords = intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const nodes = Array.from(graph.nodes.values());

    const scored = nodes.map((node) => {
      const text = `${node.method} ${node.url_template} ${node.params.map((p) => p.name).join(" ")}`.toLowerCase();
      const score = intentWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      return { node, score };
    });

    const relevant = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.node);

    if (relevant.length === 0) return [];

    // Order by sequence edges (topological sort on relevant nodes)
    return topologicalSort(relevant, graph);
  };
}

function topologicalSort(nodes: GraphNode[], graph: ApiGraph): GraphNode[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }

  for (const edge of graph.edges) {
    if (edge.edge_type === "sequence" && nodeIds.has(edge.from_endpoint_id) && nodeIds.has(edge.to_endpoint_id)) {
      adjacency.get(edge.from_endpoint_id)!.push(edge.to_endpoint_id);
      inDegree.set(edge.to_endpoint_id, (inDegree.get(edge.to_endpoint_id) ?? 0) + 1);
    }
  }

  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const result: GraphNode[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const nextId of adjacency.get(node.id) ?? []) {
      const deg = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, deg);
      if (deg === 0) {
        const next = nodes.find((n) => n.id === nextId);
        if (next) queue.push(next);
      }
    }
  }

  return result.length === nodes.length ? result : nodes; // fallback to original order
}
