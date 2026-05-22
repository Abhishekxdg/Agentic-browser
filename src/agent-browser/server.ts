/**
 * Agent Browser Server
 * REST API for AI agents to control the browser via semantic actions.
 */

import {
  createSession,
  getSession,
  closeSession,
  refreshPageModel,
  executeAction,
  listSessions,
  cleanupStaleSessions,
  listTabs,
  openTab,
  switchTab,
  closeTab,
} from "./session-manager.ts";
import type { SemanticAction } from "./action-resolver.ts";
import { createStreamObserver, type PageMutation } from "./stream-observer.ts";

const PORT = Number(process.env.AGENT_BROWSER_PORT) || 3001;
const API_KEY = process.env.AGENT_BROWSER_API_KEY ?? "dev-key";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function requireAuth(req: Request): string | Response {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }
  const key = auth.slice(7);
  if (key !== API_KEY) {
    return json({ error: "Invalid API key" }, 401);
  }
  return key;
}

// Precompiled route patterns
const WS_STREAM_RE = /^\/session\/([^/]+)\/stream$/;
const SESSION_ID_RE = /^\/session\/([^/]+)$/;
const SESSION_PATH_RE = /^\/session\/([^/]+)(\/.*)?$/;
const TAB_ID_RE = /^\/tabs\/([^/]+)$/;

// Active WebSocket connections per session
const wsConnections = new Map<string, Set<import("bun").ServerWebSocket<WSData>>>();

interface WSData {
  sessionId: string;
}

const server = Bun.serve<WSData>({
  port: PORT,
  websocket: {
    async open(ws) {
      const sessionId = ws.data.sessionId;
      const conns = wsConnections.get(sessionId) ?? new Set();
      conns.add(ws);
      wsConnections.set(sessionId, conns);

      const session = getSession(sessionId);
      if (session) {
        if (!session.streamObserver) {
          session.streamObserver = createStreamObserver(session.cdp);
          await session.streamObserver.start();
          session.streamObserver.on("mutation", (mutation: PageMutation) => {
            const payload = JSON.stringify({ type: "mutation", data: mutation });
            const conns2 = wsConnections.get(sessionId);
            if (conns2) {
              for (const c of conns2) {
                if (c.readyState === 1) c.send(payload);
              }
            }
          });
        }
        try {
          const model = await refreshPageModel(session);
          ws.send(JSON.stringify({ type: "page_model", data: model }));
        } catch {
          // Ignore
        }
      }
    },

    message(ws, message) {
      const text = typeof message === "string" ? message : message.toString("utf-8");
      try {
        const action = JSON.parse(text) as SemanticAction & { id?: string };
        const sessionId = ws.data.sessionId;
        const session = getSession(sessionId);
        if (session) {
          executeAction(session, action).then((result) => {
            ws.send(JSON.stringify({
              type: "action_result",
              id: action.id,
              success: result.success,
              data: result.data,
              error: result.error,
              page: session.pageModel,
            }));
          });
        }
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid action JSON" }));
      }
    },

    close(ws) {
      const sessionId = ws.data.sessionId;
      const conns = wsConnections.get(sessionId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) wsConnections.delete(sessionId);
      }
    },
  },

  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check (no auth required)
    if (path === "/health") {
      return json({
        status: "ok",
        service: "agent-browser",
        version: "0.2.0",
        mode: "semantic",
      });
    }

    // Auth middleware
    const authResult = requireAuth(req);
    if (authResult instanceof Response) return authResult;

    // ── WebSocket Upgrade ───────────────────────────────────
    const wsMatch = WS_STREAM_RE.exec(path);
    if (wsMatch && req.headers.get("upgrade") === "websocket") {
      const sessionId = wsMatch[1]!;
      const session = getSession(sessionId);
      if (!session) {
        return json({ error: "Session not found" }, 404);
      }
      const success = server.upgrade(req, { data: { sessionId } as WSData });
      if (success) {
        return undefined as unknown as Response; // Bun handles the response
      }
      return json({ error: "WebSocket upgrade failed" }, 500);
    }

    // ── Sessions ─────────────────────────────────────────────

    // POST /session — create a new browser session
    if (path === "/session" && req.method === "POST") {
      try {
        const body = await readBody<{ headless?: boolean; proxy?: string; attachToRunning?: boolean; remoteDebuggingPort?: number }>(req);
        const session = await createSession({
          browser: {
            headless: body.headless ?? true,
            proxy: body.proxy,
            attachToRunning: body.attachToRunning,
            remoteDebuggingPort: body.remoteDebuggingPort,
          },
        });
        return json({
          session_id: session.id,
          status: "created",
          connected: session.cdp.isConnected,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /session — list all sessions
    if (path === "/session" && req.method === "GET") {
      return json({ sessions: listSessions() });
    }

    // DELETE /session/:id — close a session
    const sessionDeleteMatch = SESSION_ID_RE.exec(path);
    if (sessionDeleteMatch && req.method === "DELETE") {
      const sessionId = sessionDeleteMatch[1]!;
      const closed = await closeSession(sessionId);
      if (!closed) {
        return json({ error: "Session not found" }, 404);
      }
      return json({ status: "closed", session_id: sessionId });
    }

    // ── Session-scoped routes ─────────────────────────────────

    const sessionPathMatch = SESSION_PATH_RE.exec(path);
    if (!sessionPathMatch) {
      return json({ error: "Not found" }, 404);
    }

    const sessionId = sessionPathMatch[1]!;
    const subPath = sessionPathMatch[2] ?? "";
    const session = getSession(sessionId);

    if (!session) {
      return json({ error: "Session not found" }, 404);
    }

    // POST /session/:id/reconnect — reconnect dropped WebSocket
    if (subPath === "/reconnect" && req.method === "POST") {
      try {
        await session.cdp.reconnect();
        session.pageModel = null;
        return json({ status: "reconnected", connected: session.cdp.isConnected });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /session/:id — session info
    if (subPath === "" || subPath === "/") {
      if (req.method === "GET") {
        return json({
          session_id: session.id,
          created_at: session.createdAt.toISOString(),
          last_active: session.lastActive.toISOString(),
          connected: session.cdp.isConnected,
          has_page_model: session.pageModel !== null,
        });
      }
      return json({ error: "Method not allowed" }, 405);
    }

    // POST /session/:id/navigate — navigate to URL
    if (subPath === "/navigate" && req.method === "POST") {
      const body = await readBody<{ url: string }>(req);
      if (!body.url) {
        return json({ error: "Missing 'url'" }, 400);
      }
      const result = await executeAction(session, { type: "navigate", url: body.url });
      if (result.success) {
        const model = await refreshPageModel(session);
        return json({ status: "navigated", page: model });
      }
      return json({ status: "error", error: result.error }, 500);
    }

    // GET /session/:id/page — get semantic page model
    if (subPath === "/page" && req.method === "GET") {
      try {
        const model = await refreshPageModel(session);
        return json({ page: model });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/action — execute a semantic action
    if (subPath === "/action" && req.method === "POST") {
      const action = await readBody<SemanticAction>(req);
      if (!action || !action.type) {
        return json({ error: "Missing action object with 'type' field" }, 400);
      }
      const result = await executeAction(session, action);
      return json({
        success: result.success,
        data: result.data,
        error: result.error,
        page: session.pageModel,
      });
    }

    // POST /session/:id/evaluate — run arbitrary JS in the page
    if (subPath === "/evaluate" && req.method === "POST") {
      const body = await readBody<{ expression: string }>(req);
      if (!body.expression) return json({ error: "Missing 'expression'" }, 400);
      try {
        const result = await session.cdp.evaluate(body.expression);
        return json({ success: true, result });
      } catch (err) {
        return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/actions — execute multiple actions in sequence
    if (subPath === "/actions" && req.method === "POST") {
      const body = await readBody<{ actions: SemanticAction[] }>(req);
      if (!body.actions || !Array.isArray(body.actions)) {
        return json({ error: "Missing 'actions' array" }, 400);
      }

      const results = [];
      for (const action of body.actions) {
        const result = await executeAction(session, action);
        results.push(result);
        if (!result.success) break;
      }

      return json({
        results,
        page: session.pageModel,
      });
    }

    // POST /session/:id/auth — not yet implemented
    if (subPath === "/auth" && req.method === "POST") {
      return json({ error: "Auth configuration endpoint not yet implemented" }, 501);
    }

    // ── Convenience endpoints ─────────────────────────────────

    // GET /session/:id/screenshot — capture screenshot
    if (subPath === "/screenshot" && req.method === "GET") {
      try {
        const fullPage = new URL(req.url).searchParams.get("fullPage") === "true";
        const data = await session.cdp.screenshot(fullPage);
        return new Response(Buffer.from(data, "base64"), {
          headers: { "Content-Type": "image/png" },
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /session/:id/cookies — get cookies
    if (subPath === "/cookies" && req.method === "GET") {
      try {
        const url = new URL(req.url).searchParams.get("url") ?? undefined;
        const cookies = await session.cdp.getCookies(url);
        return json({ cookies });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/cookies — set a cookie
    if (subPath === "/cookies" && req.method === "POST") {
      try {
        const body = await readBody<{ name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number }>(req);
        await session.cdp.setCookie(body);
        return json({ status: "set" });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // DELETE /session/:id/cookies — clear all cookies
    if (subPath === "/cookies" && req.method === "DELETE") {
      try {
        await session.cdp.clearCookies();
        return json({ status: "cleared" });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/history — back/forward/refresh
    if (subPath === "/history" && req.method === "POST") {
      try {
        const body = await readBody<{ direction: "back" | "forward" | "refresh" }>(req);
        await session.cdp.history(body.direction);
        const model = await refreshPageModel(session);
        return json({ status: "navigated", page: model });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/dialog — handle alert/confirm/prompt
    if (subPath === "/dialog" && req.method === "POST") {
      try {
        const body = await readBody<{ accept: boolean; text?: string }>(req);
        await session.cdp.handleDialog(body.accept, body.text);
        return json({ status: "handled" });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ── Tab management ────────────────────────────────────────

    // GET /session/:id/tabs — list open tabs
    if (subPath === "/tabs" && req.method === "GET") {
      try {
        const tabs = await listTabs(session);
        return json({ tabs });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/tabs — open a new tab
    if (subPath === "/tabs" && req.method === "POST") {
      try {
        const body = await readBody<{ url?: string }>(req);
        const tabId = await openTab(session, body.url);
        return json({ tab_id: tabId, status: "opened" });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // Tab-scoped: /session/:id/tabs/:tabId
    const tabMatch = TAB_ID_RE.exec(subPath);
    if (tabMatch) {
      const tabId = tabMatch[1]!;

      // PUT /session/:id/tabs/:tabId — switch to tab
      if (req.method === "PUT") {
        try {
          await switchTab(session, tabId);
          return json({ tab_id: tabId, status: "active" });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // DELETE /session/:id/tabs/:tabId — close tab
      if (req.method === "DELETE") {
        try {
          await closeTab(session, tabId);
          return json({ tab_id: tabId, status: "closed" });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      return json({ error: "Method not allowed" }, 405);
    }

    // Not found
    return json({ error: "Not found" }, 404);
  },
});

// Periodic cleanup of stale sessions
setInterval(() => {
  cleanupStaleSessions(30 * 60 * 1000).then((count) => {
    if (count > 0) console.log(`[cleanup] Closed ${count} stale sessions`);
  });
}, 60 * 1000);

console.log(`Agent Browser (semantic) running at http://localhost:${server.port}`);
console.log(`  POST   /session                        — Create new browser session`);
console.log(`  GET    /session/:id/page               — Get semantic page model`);
console.log(`  POST   /session/:id/navigate           — Navigate to URL`);
console.log(`  POST   /session/:id/action             — Execute any semantic action`);
console.log(`  POST   /session/:id/actions            — Execute action sequence`);
console.log(`  WS     /session/:id/stream             — Stream page mutations + receive actions`);
console.log(`  GET    /session/:id/screenshot         — Capture screenshot (PNG)`);
console.log(`  GET    /session/:id/cookies            — Get cookies`);
console.log(`  POST   /session/:id/cookies            — Set a cookie`);
console.log(`  DELETE /session/:id/cookies            — Clear all cookies`);
console.log(`  POST   /session/:id/history            — Navigate history { direction: back|forward|refresh }`);
console.log(`  POST   /session/:id/dialog             — Handle dialog { accept, text? }`);
console.log(`  GET    /session/:id/tabs               — List open tabs`);
console.log(`  POST   /session/:id/tabs               — Open new tab { url? }`);
console.log(`  PUT    /session/:id/tabs/:tabId        — Switch to tab`);
console.log(`  DELETE /session/:id/tabs/:tabId        — Close tab`);
console.log(``);
console.log(`  Action types: navigate, fill, click, double_click, right_click, hover,`);
console.log(`    select, scroll, press, type_text, keyboard_shortcut, extract,`);
console.log(`    screenshot, history, wait, wait_for, upload_file, drag_drop,`);
console.log(`    get_cookies, set_cookie, clear_cookies, handle_dialog,`);
console.log(`    get_storage, set_storage, get_text, get_iframes,`);
console.log(`    open_tab, switch_tab, close_tab, list_tabs`);
