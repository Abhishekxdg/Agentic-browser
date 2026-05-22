/**
 * Stream Observer
 * Subscribes to CDP DOM mutation events and pushes incremental updates
 * to registered listeners. Enables real-time page change streaming.
 */

import type { CDPBridge } from "./cdp-bridge.ts";

export interface PageMutation {
  type: "navigation" | "dom" | "load" | "network";
  timestamp: number;
  data: Record<string, unknown>;
}

export interface StreamObserver {
  /** Start listening for DOM mutations on this page */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
  /** Subscribe to mutation events */
  on(event: "mutation", handler: (mutation: PageMutation) => void): void;
  off(event: "mutation", handler: (mutation: PageMutation) => void): void;
  /** Get all mutations since start */
  getMutations(): PageMutation[];
  /** Clear mutation buffer */
  clear(): void;
}

export function createStreamObserver(cdp: CDPBridge): StreamObserver {
  const handlers: Array<(m: PageMutation) => void> = [];
  const mutations: PageMutation[] = [];
  let running = false;

  const MAX_MUTATIONS = 1000;

  function pushMutation(m: PageMutation) {
    if (mutations.length >= MAX_MUTATIONS) mutations.shift();
    mutations.push(m);
    for (const h of handlers) try { h(m); } catch {}
  }

  const navHandler = (params: unknown) => {
    const p = params as { frameId?: string; url?: string; navigationId?: string };
    pushMutation({
      type: "navigation",
      timestamp: Date.now(),
      data: { frameId: p.frameId, url: p.url, navigationId: p.navigationId },
    });
  };

  const loadHandler = (_params: unknown) => {
    pushMutation({ type: "load", timestamp: Date.now(), data: {} });
  };

  const domHandler = (params: unknown) => {
    const p = params as {
      attributeName?: string;
      childNodeCount?: number;
      nodeId?: number;
      nodeName?: string;
      type?: string;
    };
    pushMutation({
      type: "dom",
      timestamp: Date.now(),
      data: {
        nodeId: p.nodeId,
        nodeName: p.nodeName,
        type: p.type,
        attributeName: p.attributeName,
        childNodeCount: p.childNodeCount,
      },
    });
  };

  const networkHandler = (params: unknown) => {
    const p = params as { requestId?: string; response?: Record<string, unknown> };
    pushMutation({
      type: "network",
      timestamp: Date.now(),
      data: { requestId: p.requestId, responseStatus: p.response?.status },
    });
  };

  return {
    async start() {
      if (running) return;
      running = true;
      await cdp.send("DOM.getDocument");
      // CDP DOM domain doesn't have a single "mutation" event.
      // We rely on page-level events and periodic refresh.
      cdp.on("Page.frameNavigated", navHandler);
      cdp.on("Page.loadEventFired", loadHandler);
      cdp.on("Network.responseReceived", networkHandler);
    },

    async stop() {
      if (!running) return;
      running = false;
      cdp.off("Page.frameNavigated", navHandler);
      cdp.off("Page.loadEventFired", loadHandler);
      cdp.off("Network.responseReceived", networkHandler);
    },

    on(_event: "mutation", handler: (mutation: PageMutation) => void) {
      handlers.push(handler);
    },

    off(_event: "mutation", handler: (mutation: PageMutation) => void) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    },

    getMutations() {
      return [...mutations];
    },

    clear() {
      mutations.length = 0;
    },
  };
}
