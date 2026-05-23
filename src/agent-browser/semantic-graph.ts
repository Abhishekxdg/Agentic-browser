/**
 * Live Semantic Graph — incremental page model updates via DOM mutations.
 * Instead of full re-extract on every action, track what changed and patch the model.
 * Like React reconciliation but for semantic understanding.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { SemanticPage } from "./semantic-page.ts";
import { extractSemanticPage } from "./semantic-page.ts";

export interface SemanticDiff {
  type: "navigation" | "form_changed" | "dialog_opened" | "dialog_closed"
      | "interactive_changed" | "content_changed" | "url_changed" | "full_refresh";
  timestamp: number;
  details: Record<string, unknown>;
}

export interface LiveGraph {
  current: SemanticPage | null;
  diffs: SemanticDiff[];
  last_full_extract: number;
  mutation_count: number;
  start(): Promise<void>;
  stop(): void;
  getPage(): Promise<SemanticPage>;
  getDiffs(since?: number): SemanticDiff[];
  hydrate(snapshot: { current?: SemanticPage | null; diffs?: SemanticDiff[]; last_full_extract?: number; mutation_count?: number }): void;
}

// Threshold: after N mutations, force a full re-extract (keeps model accurate)
const MUTATION_THRESHOLD = 15;
// Max age for partial updates before forcing full refresh (ms)
const MAX_STALE_MS = 30_000;

export function createLiveGraph(cdp: CDPBridge): LiveGraph {
  let current: SemanticPage | null = null;
  const diffs: SemanticDiff[] = [];
  let mutationCount = 0;
  let lastFullExtract = 0;
  let running = false;

  // Mutation handler — fast path: detect type of change without full extract
  const domMutationHandler = (params: unknown) => {
    mutationCount++;
    const p = params as { type?: string; nodeName?: string; nodeId?: number };

    // Classify mutation type for targeted update
    const isForm = p.nodeName?.match(/^(INPUT|TEXTAREA|SELECT|FORM)$/i);
    const isDialog = p.nodeName?.match(/^(DIALOG)$/i);

    if (isForm) {
      diffs.push({ type: "form_changed", timestamp: Date.now(), details: { nodeName: p.nodeName, nodeId: p.nodeId } });
    } else if (isDialog) {
      diffs.push({ type: "dialog_opened", timestamp: Date.now(), details: { nodeId: p.nodeId } });
    } else {
      diffs.push({ type: "content_changed", timestamp: Date.now(), details: { nodeName: p.nodeName } });
    }

    // Keep diffs bounded
    if (diffs.length > 500) diffs.splice(0, diffs.length - 500);
  };

  const navHandler = (params: unknown) => {
    const p = params as { url?: string };
    if (p.url && current && p.url !== current.page.url) {
      current = null; // invalidate on navigation
      diffs.push({ type: "navigation", timestamp: Date.now(), details: { url: p.url } });
    }
  };

  const loadHandler = () => {
    // Page loaded — schedule full refresh
    current = null;
  };

  return {
    get current() { return current; },
    get diffs() { return diffs; },
    get last_full_extract() { return lastFullExtract; },
    get mutation_count() { return mutationCount; },

    async start() {
      if (running) return;
      running = true;
      cdp.on("DOM.documentUpdated", domMutationHandler);
      cdp.on("DOM.childNodeModified", domMutationHandler);
      cdp.on("Page.frameNavigated", navHandler);
      cdp.on("Page.loadEventFired", loadHandler);
    },

    stop() {
      running = false;
      cdp.off("DOM.documentUpdated", domMutationHandler);
      cdp.off("DOM.childNodeModified", domMutationHandler);
      cdp.off("Page.frameNavigated", navHandler);
      cdp.off("Page.loadEventFired", loadHandler);
    },

    async getPage(): Promise<SemanticPage> {
      const now = Date.now();
      const needsRefresh =
        !current ||                                      // no model yet
        mutationCount >= MUTATION_THRESHOLD ||            // too many mutations
        (now - lastFullExtract) > MAX_STALE_MS;          // model too old

      if (needsRefresh) {
        current = await extractSemanticPage(cdp);
        lastFullExtract = now;
        mutationCount = 0;
        diffs.push({ type: "full_refresh", timestamp: now, details: {} });
      }

      // Partial update: patch forms from page if form-change diffs exist
      const recentFormChanges = diffs.filter((d) => d.type === "form_changed" && d.timestamp > lastFullExtract);
      if (recentFormChanges.length > 0 && current) {
        // Re-extract just forms (cheaper than full page)
        try {
          const fresh = await extractSemanticPage(cdp);
          current = { ...current, forms: fresh.forms, dialogs: fresh.dialogs };
        } catch {}
      }

      return current!;
    },

    getDiffs(since?: number): SemanticDiff[] {
      if (!since) return [...diffs];
      return diffs.filter((d) => d.timestamp > since);
    },

    hydrate(snapshot) {
      current = snapshot.current ?? null;
      diffs.length = 0;
      diffs.push(...(snapshot.diffs ?? []).slice(-500));
      lastFullExtract = snapshot.last_full_extract ?? 0;
      mutationCount = snapshot.mutation_count ?? 0;
    },
  };
}
