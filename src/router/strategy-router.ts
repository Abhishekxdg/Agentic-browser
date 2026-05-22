import type { Page } from "playwright";
import type { ApiGraph, GraphNode } from "../graph/types.ts";

export type ExecutionStrategy = "api_replay" | "dom_control" | "vision_ai";

export interface StrategyContext {
  intent: string;
  siteUrl: string;
  graph?: ApiGraph;
  page?: Page;
  lastError?: { strategy: ExecutionStrategy; error: string };
  attemptCount: number;
}

export interface StrategyResult {
  strategy: ExecutionStrategy;
  confidence: number;
  reason: string;
  apiSequence?: GraphNode[];
}

/**
 * Auto-selects the best execution strategy based on available data and previous failures.
 * Priority: API Replay → DOM Control → Vision AI
 */
export function selectStrategy(ctx: StrategyContext): StrategyResult {
  const { intent, graph, lastError, attemptCount } = ctx;

  // If we've already tried and failed with a strategy, fall back
  if (lastError) {
    if (lastError.strategy === "api_replay") {
      return {
        strategy: "dom_control",
        confidence: 0.7,
        reason: "API replay failed (drift or auth error). Falling back to DOM control.",
      };
    }
    if (lastError.strategy === "dom_control") {
      return {
        strategy: "vision_ai",
        confidence: 0.6,
        reason: "DOM control failed (dynamic content or complex UI). Falling back to vision AI.",
      };
    }
    // Vision AI failed — nothing left to try
    return {
      strategy: "vision_ai",
      confidence: 0.3,
      reason: "All strategies exhausted. Returning last error.",
    };
  }

  // First attempt: try API replay if we have a graph
  if (graph && graph.nodes.size > 0) {
    const matchingNodes = findMatchingNodes(intent, graph);
    if (matchingNodes.length > 0) {
      return {
        strategy: "api_replay",
        confidence: 0.9,
        reason: `Found ${matchingNodes.length} matching API endpoints in graph for intent: "${intent}"`,
        apiSequence: matchingNodes,
      };
    }
  }

  // No graph or no match — try DOM control if we have a page
  if (ctx.page) {
    return {
      strategy: "dom_control",
      confidence: 0.75,
      reason: "No API graph match. Using DOM control with Playwright.",
    };
  }

  // No page available — this shouldn't happen in normal flow, but fallback to vision
  return {
    strategy: "vision_ai",
    confidence: 0.5,
    reason: "No API graph or page context. Vision AI as last resort.",
  };
}

/**
 * Simple keyword-based matching against endpoint URL templates and params.
 * In production, this would use embeddings + vector search (pgvector).
 */
function findMatchingNodes(intent: string, graph: ApiGraph): GraphNode[] {
  const intentWords = intent.toLowerCase().split(/\s+/);
  const matches: Array<{ node: GraphNode; score: number }> = [];

  for (const node of graph.nodes.values()) {
    let score = 0;
    const template = node.url_template.toLowerCase();
    const params = node.params.map((p) => p.name.toLowerCase()).join(" ");
    const text = `${template} ${params}`;

    for (const word of intentWords) {
      if (text.includes(word)) score++;
    }

    // Boost score for exact verb match (GET/POST vs intent action)
    const intentAction = intentWords[0]; // e.g. "submit", "get", "delete"
    if (intentAction && template.includes(intentAction)) score += 2;

    if (score > 0) {
      matches.push({ node, score });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  // Return top matches that form a valid sequence
  // For now, just return the highest scoring ones
  const topMatches = matches.slice(0, 5).map((m) => m.node);

  // Sort by prerequisite order if possible
  return sortByPrerequisites(topMatches);
}

function sortByPrerequisites(nodes: GraphNode[]): GraphNode[] {
  // Simple topological sort based on prerequisite_endpoints
  const sorted: GraphNode[] = [];
  const seen = new Set<string>();

  function visit(node: GraphNode) {
    const id = node.id;
    if (seen.has(id)) return;

    for (const prereq of node.prerequisite_endpoints) {
      const prereqNode = nodes.find((n) => n.url_template === prereq);
      if (prereqNode) visit(prereqNode);
    }

    seen.add(id);
    sorted.push(node);
  }

  for (const node of nodes) {
    visit(node);
  }

  return sorted;
}
