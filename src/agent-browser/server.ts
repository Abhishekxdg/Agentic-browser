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
import { saveCookies, loadCookies, listProfiles, deleteProfile } from "../mcp/cookie-store.ts";
import { startRecording, stopRecording, listActiveRecordings } from "../layer2/recorder-bridge.ts";
import { loadGraph, listGraphs, deleteGraph } from "../layer2/graph-store.ts";
import { executeIntent, type ExecutionContext } from "../executor/engine.ts";
import { createIntentResolver } from "../layer2/intent-resolver.ts";

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

// Extension WebSocket connection (one at a time — one real browser)
let extensionWs: import("bun").ServerWebSocket<WSData> | null = null;
let extCommandCallbacks = new Map<string, (result: unknown) => void>();
let extCmdId = 0;

interface WSData {
  sessionId: string;
  isExtension?: boolean;
}

const server = Bun.serve<WSData>({
  port: PORT,
  websocket: {
    async open(ws) {
      // Extension connection
      if (ws.data.isExtension) {
        extensionWs = ws;
        console.log("[ext] Chrome extension connected");
        return;
      }

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

      // Extension messages
      if (ws.data.isExtension) {
        try {
          const msg = JSON.parse(text) as { type: string; id?: string; [k: string]: unknown };
          if (msg.type === "EXTENSION_HELLO") {
            console.log("[ext] extension authenticated");
            return;
          }
          if (msg.type === "COMMAND_RESULT" && msg.id) {
            const cb = extCommandCallbacks.get(msg.id);
            if (cb) { extCommandCallbacks.delete(msg.id); cb(msg); }
            return;
          }
          // Network captures during recording — relay to any interested listeners
          if (msg.type === "NETWORK_CAPTURE" || msg.type === "RECORDING_STARTED" || msg.type === "RECORDING_STOPPED") {
            console.log(`[ext] ${msg.type}`);
            return;
          }
        } catch {}
        return;
      }

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
      if (ws.data.isExtension) {
        extensionWs = null;
        console.log("[ext] Chrome extension disconnected");
        return;
      }
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

    // ── Extension WebSocket upgrade ──────────────────────────
    if (path === "/extension/stream" && req.headers.get("upgrade") === "websocket") {
      const success = server.upgrade(req, { data: { sessionId: "extension", isExtension: true } as WSData });
      if (success) return undefined as unknown as Response;
      return json({ error: "WebSocket upgrade failed" }, 500);
    }

    // GET /extension/status — check if extension is connected
    if (path === "/extension/status" && req.method === "GET") {
      return json({ connected: extensionWs !== null && extensionWs.readyState === 1 });
    }

    // POST /extension/command — send a command to the extension and wait for result
    if (path === "/extension/command" && req.method === "POST") {
      if (!extensionWs || extensionWs.readyState !== 1) {
        return json({ error: "Chrome extension not connected. Install and enable it first." }, 503);
      }
      const body = await readBody<{ type: string; [k: string]: unknown }>(req);
      const id = `cmd_${++extCmdId}_${Date.now()}`;
      const timeout = Number(new URL(req.url).searchParams.get("timeout") || "15000");

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          extCommandCallbacks.delete(id);
          resolve({ success: false, error: "Extension command timeout" });
        }, timeout);
        extCommandCallbacks.set(id, (r) => { clearTimeout(timer); resolve(r); });
        extensionWs!.send(JSON.stringify({ ...body, id }));
      });

      return json(result as object);
    }

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

    // ── Layer 2: Recording ────────────────────────────────────────────────

    // POST /record/start — open headed browser, start intercepting network
    if (path === "/record/start" && req.method === "POST") {
      try {
        const body = await readBody<{ org_id?: string; site_url: string }>(req);
        if (!body.site_url) return json({ error: "Missing 'site_url'" }, 400);
        const result = await startRecording(body.org_id ?? "default", body.site_url);
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /record/stop — stop recording, extract graph, save to disk
    if (path === "/record/stop" && req.method === "POST") {
      try {
        const body = await readBody<{ org_id?: string; site_url: string; workflow_name: string }>(req);
        if (!body.site_url) return json({ error: "Missing 'site_url'" }, 400);
        if (!body.workflow_name) return json({ error: "Missing 'workflow_name'" }, 400);
        const result = await stopRecording(body.org_id ?? "default", body.site_url, body.workflow_name);
        return json({
          recording_id: result.recording_id,
          workflow_name: result.workflow_name,
          endpoints_captured: result.endpoints_captured,
          graph_version: result.graph_version,
          node_count: result.graph.nodes.size,
          edge_count: result.graph.edges.length,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /record/active — list active recordings
    if (path === "/record/active" && req.method === "GET") {
      return json({ recordings: listActiveRecordings() });
    }

    // ── Layer 2: Graphs ───────────────────────────────────────────────────

    // GET /graphs — list all saved graphs
    if (path === "/graphs" && req.method === "GET") {
      const orgId = new URL(req.url).searchParams.get("org_id") ?? undefined;
      return json({ graphs: listGraphs(orgId) });
    }

    // GET /graphs/:org/:site — get a specific graph
    if (path.startsWith("/graphs/") && req.method === "GET") {
      const parts = path.slice("/graphs/".length).split("/");
      if (parts.length < 2) return json({ error: "Path: /graphs/:org_id/:site_host" }, 400);
      const [orgId, ...siteParts] = parts;
      const siteHost = siteParts.join("/");
      const graph = loadGraph(orgId!, siteHost!);
      if (!graph) return json({ error: "Graph not found" }, 404);
      return json({
        org_id: graph.org_id,
        site_host: graph.site_host,
        graph_version: graph.graph_version,
        nodes: Array.from(graph.nodes.values()),
        edges: graph.edges,
      });
    }

    // DELETE /graphs/:org/:site — delete a graph
    if (path.startsWith("/graphs/") && req.method === "DELETE") {
      const parts = path.slice("/graphs/".length).split("/");
      if (parts.length < 2) return json({ error: "Path: /graphs/:org_id/:site_host" }, 400);
      const [orgId, ...siteParts] = parts;
      const siteHost = siteParts.join("/");
      const deleted = deleteGraph(orgId!, siteHost!);
      return deleted ? json({ status: "deleted" }) : json({ error: "Graph not found" }, 404);
    }

    // ── Layer 2: Execute intent ───────────────────────────────────────────

    // POST /do — execute a natural language intent against a recorded graph
    if (path === "/do" && req.method === "POST") {
      try {
        const body = await readBody<{
          site: string;
          intent: string;
          org_id?: string;
          auth_token?: string;
          cookies?: Record<string, string>;
          llm_provider?: "gemini" | "openai" | "keyword";
        }>(req);

        if (!body.site) return json({ error: "Missing 'site'" }, 400);
        if (!body.intent) return json({ error: "Missing 'intent'" }, 400);

        const orgId = body.org_id ?? "default";
        let siteHost: string;
        try { siteHost = new URL(body.site).host; }
        catch { return json({ error: "Invalid 'site' URL" }, 400); }

        const graph = loadGraph(orgId, siteHost);
        if (!graph) {
          return json({
            error: `No recorded graph for ${siteHost} (org: ${orgId}). Record a workflow first with POST /record/start.`,
            hint: "Use POST /record/start to record a workflow, then POST /record/stop to save it.",
          }, 404);
        }

        const ctx: ExecutionContext = {
          org_id: orgId,
          auth_token: body.auth_token,
          cookies: body.cookies,
          base_url: body.site,
          on_drift_detected: (endpoint) => {
            console.error(`[layer2] drift detected: ${endpoint} — consider re-recording`);
          },
        };

        const resolver = createIntentResolver(body.llm_provider);
        const result = await executeIntent(body.intent, graph, ctx, resolver);

        return json({
          success: result.success,
          intent: body.intent,
          site: body.site,
          steps: result.steps,
          error: result.error,
          error_class: result.error_class,
          graph_version: graph.graph_version,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /auth/profiles — list saved cookie profiles
    if (path === "/auth/profiles" && req.method === "GET") {
      const profiles = await listProfiles();
      return json({ profiles });
    }

    // DELETE /auth/profiles/:name — delete a profile
    if (path.startsWith("/auth/profiles/") && req.method === "DELETE") {
      const name = path.slice("/auth/profiles/".length);
      const deleted = await deleteProfile(name);
      return deleted ? json({ status: "deleted", profile: name }) : json({ error: "Profile not found" }, 404);
    }

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
          extension_loaded: process.env.EXTENSION_PATH !== undefined && process.env.EXTENSION_DISABLED !== "true",
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

    // POST /session/:id/auth/save — save cookies to named profile
    if (subPath === "/auth/save" && req.method === "POST") {
      const body = await readBody<{ profile: string }>(req);
      if (!body.profile) return json({ error: "Missing 'profile'" }, 400);
      try {
        const cookies = await session.cdp.getCookies();
        await saveCookies(body.profile, cookies);
        return json({ status: "saved", profile: body.profile, cookies_saved: cookies.length });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/auth/load — load cookies from named profile
    if (subPath === "/auth/load" && req.method === "POST") {
      const body = await readBody<{ profile: string }>(req);
      if (!body.profile) return json({ error: "Missing 'profile'" }, 400);
      const cookies = await loadCookies(body.profile);
      if (!cookies) return json({ error: `Profile "${body.profile}" not found` }, 404);
      let loaded = 0;
      for (const cookie of cookies) {
        try { await session.cdp.setCookie(cookie); loaded++; } catch { /* skip expired */ }
      }
      return json({ status: "loaded", profile: body.profile, cookies_loaded: loaded });
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
console.log(``);
console.log(`Layer 2 — API Replay Engine:`);
console.log(`  POST   /record/start                   — Open headed browser, start recording`);
console.log(`  POST   /record/stop                    — Stop recording, extract graph, save`);
console.log(`  GET    /record/active                  — List active recordings`);
console.log(`  GET    /graphs                         — List all saved API graphs`);
console.log(`  GET    /graphs/:org_id/:site_host      — Get a specific graph`);
console.log(`  DELETE /graphs/:org_id/:site_host      — Delete a graph`);
console.log(`  POST   /do                             — Execute natural language intent`);
console.log(`    { site, intent, org_id?, auth_token?, cookies?, llm_provider? }`);
