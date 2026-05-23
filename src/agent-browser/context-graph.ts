/**
 * Cross-Page Context Graph — connects pages semantically across a workflow.
 * Amazon product ↔ Cart ↔ Checkout ↔ Payment
 * Tracks: how pages relate, what data flows between them, breadcrumb path.
 */

import type { SemanticPage } from "./semantic-page.ts";

export interface PageNode {
  url: string;
  title: string;
  purpose?: string;   // inferred: "product_detail", "cart", "checkout", "login", "search_results", etc.
  key_data: Record<string, string>; // extracted key values: {product_name, price, cart_count, ...}
  visited_at: number;
  actions_taken: string[]; // actions performed on this page
}

export interface PageEdge {
  from_url: string;
  to_url: string;
  trigger: string;    // what action caused navigation
  data_carried: Record<string, string>; // what data moved between pages
  timestamp: number;
}

export interface ContextGraph {
  session_id: string;
  nodes: Map<string, PageNode>;
  edges: PageEdge[];
  current_url: string;
  breadcrumb: string[];  // ordered navigation path

  addPage(page: SemanticPage, actionsOnPage?: string[]): void;
  addTransition(fromUrl: string, toUrl: string, trigger: string): void;
  getContext(): { current: PageNode | null; history: PageNode[]; breadcrumb: string[] };
  getRelatedPages(url: string): PageNode[];
  extractKeyData(page: SemanticPage): Record<string, string>;
  getWorkflowSummary(): string;
  exportSnapshot(): {
    current_url: string;
    breadcrumb: string[];
    nodes: PageNode[];
    edges: PageEdge[];
  };
  hydrate(snapshot: { current_url?: string; breadcrumb?: string[]; nodes?: PageNode[]; edges?: PageEdge[] }): void;
}

// Infer page purpose from URL + title + content
function inferPurpose(page: SemanticPage): string {
  const url = page.page.url.toLowerCase();
  const title = page.page.title.toLowerCase();
  const combined = `${url} ${title}`;

  if (/login|signin|sign-in|auth/.test(combined)) return "authentication";
  if (/cart|basket|bag/.test(combined)) return "cart";
  if (/checkout|payment|pay|order/.test(combined)) return "checkout";
  if (/confirm|success|thank/.test(combined)) return "confirmation";
  if (/search|results|find/.test(combined)) return "search_results";
  if (/product|item|detail|pdp/.test(combined)) return "product_detail";
  if (/dashboard|home|overview/.test(combined)) return "dashboard";
  if (/settings|account|profile/.test(combined)) return "settings";
  if (/inbox|mail|message/.test(combined)) return "email";
  if (/signup|register|create.*account/.test(combined)) return "registration";
  return "content";
}

// Extract key data values from page (prices, counts, names, IDs)
function extractKeyData(page: SemanticPage): Record<string, string> {
  const data: Record<string, string> = {};

  // Extract from forms: field values
  for (const form of page.forms) {
    for (const field of form.fields) {
      if (field.value && typeof field.value === "string" && field.value.length < 100) {
        if (!field.name.toLowerCase().includes("password")) {
          data[field.name] = String(field.value);
        }
      }
    }
  }

  // Extract from page content: prices, totals, quantities
  for (const block of page.content.slice(0, 10)) {
    const text = block.text;
    // Price pattern
    const price = text.match(/\$[\d,]+\.?\d*/);
    if (price) data.price = price[0];
    // Quantity pattern
    const qty = text.match(/quantity[:\s]+(\d+)/i);
    if (qty?.[1]) data.quantity = qty[1];
    // Order number
    const order = text.match(/order[:\s#]+([A-Z0-9-]{6,})/i);
    if (order?.[1]) data.order_id = order[1];
  }

  return data;
}

export function createContextGraph(sessionId: string): ContextGraph {
  const nodes = new Map<string, PageNode>();
  const edges: PageEdge[] = [];
  let currentUrl = "";
  const breadcrumb: string[] = [];

  return {
    session_id: sessionId,
    get nodes() { return nodes; },
    get edges() { return edges; },
    get current_url() { return currentUrl; },
    get breadcrumb() { return breadcrumb; },

    addPage(page: SemanticPage, actionsOnPage: string[] = []) {
      const url = page.page.url;
      const existing = nodes.get(url);
      nodes.set(url, {
        url,
        title: page.page.title,
        purpose: inferPurpose(page),
        key_data: { ...(existing?.key_data ?? {}), ...extractKeyData(page) },
        visited_at: Date.now(),
        actions_taken: [...(existing?.actions_taken ?? []), ...actionsOnPage],
      });

      if (currentUrl !== url) {
        breadcrumb.push(url);
        if (breadcrumb.length > 20) breadcrumb.shift();
        currentUrl = url;
      }
    },

    addTransition(fromUrl: string, toUrl: string, trigger: string) {
      const fromNode = nodes.get(fromUrl);
      const toNode = nodes.get(toUrl);
      edges.push({
        from_url: fromUrl,
        to_url: toUrl,
        trigger,
        data_carried: { ...(fromNode?.key_data ?? {}), ...(toNode?.key_data ?? {}) },
        timestamp: Date.now(),
      });
      if (edges.length > 100) edges.splice(0, edges.length - 100);
    },

    getContext() {
      return {
        current: nodes.get(currentUrl) ?? null,
        history: breadcrumb.slice(-5).map((u) => nodes.get(u)).filter(Boolean) as PageNode[],
        breadcrumb: [...breadcrumb],
      };
    },

    getRelatedPages(url: string): PageNode[] {
      const related = new Set<string>();
      for (const edge of edges) {
        if (edge.from_url === url) related.add(edge.to_url);
        if (edge.to_url === url) related.add(edge.from_url);
      }
      return Array.from(related).map((u) => nodes.get(u)).filter(Boolean) as PageNode[];
    },

    extractKeyData(page: SemanticPage): Record<string, string> {
      return extractKeyData(page);
    },

    getWorkflowSummary(): string {
      if (breadcrumb.length === 0) return "No pages visited yet";
      const path = breadcrumb
        .slice(-6)
        .map((u) => {
          const n = nodes.get(u);
          return n ? `${n.purpose ?? "page"} (${new URL(u).pathname})` : u;
        })
        .join(" → ");
      const current = nodes.get(currentUrl);
      const dataKeys = Object.keys(current?.key_data ?? {});
      return `Path: ${path}${dataKeys.length ? `\nData collected: ${dataKeys.join(", ")}` : ""}`;
    },

    exportSnapshot() {
      return {
        current_url: currentUrl,
        breadcrumb: [...breadcrumb],
        nodes: Array.from(nodes.values()),
        edges: [...edges],
      };
    },

    hydrate(snapshot) {
      nodes.clear();
      for (const node of snapshot.nodes ?? []) nodes.set(node.url, node);
      edges.length = 0;
      edges.push(...(snapshot.edges ?? []).slice(-100));
      breadcrumb.length = 0;
      breadcrumb.push(...(snapshot.breadcrumb ?? []).slice(-20));
      currentUrl = snapshot.current_url ?? breadcrumb[breadcrumb.length - 1] ?? "";
    },
  };
}
