/**
 * Event Awareness — classifies and surfaces page events agents need to know about.
 * Tracks: navigation, modal opens/closes, AJAX completions, WebSocket messages,
 * lazy loading, infinite scroll triggers, auth challenges, error states.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { BrowserSession } from "./session-manager.ts";

export type PageEventType =
  | "modal_opened"
  | "modal_closed"
  | "navigation_started"
  | "navigation_completed"
  | "ajax_completed"
  | "websocket_message"
  | "error_appeared"
  | "auth_challenge"
  | "lazy_content_loaded"
  | "infinite_scroll_trigger"
  | "toast_appeared"
  | "form_submitted"
  | "captcha_appeared";

export interface PageEvent {
  type: PageEventType;
  timestamp: number;
  url?: string;
  data?: Record<string, unknown>;
  requires_action?: boolean;   // agent should respond to this
  suggested_action?: string;   // what to do
}

export interface EventAwareness {
  events: PageEvent[];
  start(): Promise<void>;
  stop(): void;
  getPending(): PageEvent[];   // events that require agent response
  clear(): void;
}

const TOAST_SELECTORS = '[role="alert"], [role="status"], .toast, .notification, .snackbar, [class*="toast"], [class*="notification"]';
const ERROR_SELECTORS = '.error, .alert-error, [role="alert"][aria-live="assertive"], .error-message, [class*="error"]';
const MODAL_SELECTORS = '[role="dialog"], [role="alertdialog"], .modal, .dialog, [aria-modal="true"]';

export function createEventAwareness(cdp: CDPBridge): EventAwareness {
  const events: PageEvent[] = [];
  let running = false;
  let wsMessageCount = 0;
  let _pollTimer: ReturnType<typeof setInterval> | null = null;

  function push(e: PageEvent) {
    if (events.length > 200) events.splice(0, events.length - 200);
    events.push(e);
  }

  // CDP event handlers
  const navStartHandler = (params: unknown) => {
    const p = params as { url?: string };
    push({ type: "navigation_started", timestamp: Date.now(), url: p.url });
  };

  const navDoneHandler = (params: unknown) => {
    const p = params as { url?: string };
    push({ type: "navigation_completed", timestamp: Date.now(), url: p.url, requires_action: false });
  };

  const networkDoneHandler = (params: unknown) => {
    const p = params as { response?: { status?: number; url?: string }; requestId?: string };
    const status = p.response?.status ?? 0;
    const url = p.response?.url ?? "";
    if (url && (url.includes("/api/") || url.includes("/v1/") || url.includes("/graphql"))) {
      push({ type: "ajax_completed", timestamp: Date.now(), url, data: { status } });
    }
    // Auth challenge detection
    if (status === 401 || status === 403) {
      push({ type: "auth_challenge", timestamp: Date.now(), url, data: { status }, requires_action: true, suggested_action: "re-authenticate or check credentials" });
    }
  };

  const wsFrameHandler = (params: unknown) => {
    const p = params as { response?: { payloadData?: string } };
    wsMessageCount++;
    if (wsMessageCount % 10 === 0) { // sample every 10th message
      push({ type: "websocket_message", timestamp: Date.now(), data: { sample: p.response?.payloadData?.slice(0, 100) } });
    }
  };

  // DOM polling for visual events (modal, toast, error)
  async function pollDom() {
    if (!running) return;
    try {
      const result = await cdp.evaluate(`
        (function() {
          const findings = [];
          const modals = document.querySelectorAll('[role="dialog"],[role="alertdialog"],.modal[style*="block"],.modal.show,[aria-modal="true"]');
          if (modals.length > 0) findings.push({type:'modal', count: modals.length, title: modals[0].querySelector('h1,h2,h3,[role=heading]')?.textContent?.trim()});
          const toasts = document.querySelectorAll('[role="alert"],[role="status"],.toast:not(.hide),.snackbar');
          if (toasts.length > 0) findings.push({type:'toast', text: toasts[0].textContent?.trim().slice(0,100)});
          const errors = document.querySelectorAll('.error-message:not(:empty),[class*="error-text"]:not(:empty)');
          if (errors.length > 0) findings.push({type:'error', text: errors[0].textContent?.trim().slice(0,100)});
          const captcha = document.querySelector('.g-recaptcha, .h-captcha, iframe[src*="captcha"]');
          if (captcha) findings.push({type:'captcha'});
          return findings;
        })()
      `) as Array<{ type: string; count?: number; title?: string; text?: string }>;

      for (const f of result ?? []) {
        const recent = events.filter((e) => Date.now() - e.timestamp < 2000);
        if (f.type === "modal" && !recent.find((e) => e.type === "modal_opened")) {
          push({ type: "modal_opened", timestamp: Date.now(), data: { title: f.title }, requires_action: true, suggested_action: "handle_dialog or read modal content" });
        }
        if (f.type === "toast") {
          push({ type: "toast_appeared", timestamp: Date.now(), data: { text: f.text } });
        }
        if (f.type === "error") {
          push({ type: "error_appeared", timestamp: Date.now(), data: { text: f.text }, requires_action: true, suggested_action: "check error message and adjust" });
        }
        if (f.type === "captcha") {
          push({ type: "captcha_appeared", timestamp: Date.now(), requires_action: true, suggested_action: "solve captcha before proceeding" });
        }
      }
    } catch { /* page may not be ready */ }
  }

  return {
    get events() { return events; },

    async start() {
      if (running) return;
      running = true;
      cdp.on("Page.frameNavigated", navDoneHandler);
      cdp.on("Page.frameStartedLoading", navStartHandler);
      cdp.on("Network.loadingFinished", networkDoneHandler);
      cdp.on("Network.webSocketFrameReceived", wsFrameHandler);
      // Poll DOM every 2 seconds for visual events
      _pollTimer = setInterval(() => pollDom(), 2000);
    },

    stop() {
      running = false;
      if (_pollTimer) clearInterval(_pollTimer);
      cdp.off("Page.frameNavigated", navDoneHandler);
      cdp.off("Page.frameStartedLoading", navStartHandler);
      cdp.off("Network.loadingFinished", networkDoneHandler);
      cdp.off("Network.webSocketFrameReceived", wsFrameHandler);
    },

    getPending(): PageEvent[] {
      return events.filter((e) => e.requires_action && Date.now() - e.timestamp < 30_000);
    },

    clear() {
      events.length = 0;
    },
  };
}
