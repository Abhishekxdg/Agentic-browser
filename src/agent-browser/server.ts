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
import { createJob, getJob, listJobs, cancelJob, resolveHITL, updateJob, type JobStatus } from "./job-queue.ts";
import { pool } from "./chrome-pool.ts";
import { createTracer, getTracer } from "./tracer.ts";
import { readdirSync, readFileSync } from "fs";
import { vaultSet, vaultGet, vaultList, vaultDelete, generateTOTP } from "./vault.ts";
import { createPlan } from "./planner.ts";
import { executePlan } from "./executor.ts";
import { saveWorkflow, loadWorkflow, listWorkflows, executeWorkflow, buildWorkflow } from "./workflow-graph.ts";
import { listSkills, loadSkill, saveSkill, resolveSkill, incrementUseCount } from "./skills.ts";
import { readAuditLog } from "./audit.ts";
import { join as pathJoin2 } from "path";
import { homedir as homedir2 } from "os";
import { runAgentLoop } from "./agent-loop.ts";
import { runPlanner } from "./task-planner.ts";
import { SemanticAuthHandler } from "./semantic-auth.ts";
import { SemanticCaptchaResolver } from "./semantic-captcha.ts";
import { listMemories, loadMemory as loadSiteMemory } from "../layer2/site-memory.ts";
import { join as pathJoin } from "path";
import { homedir } from "os";
import { unlinkSync, existsSync as fsExistsSync } from "fs";

const PORT = Number(process.env.AGENT_BROWSER_PORT) || 3001;
const API_KEY = process.env.AGENT_BROWSER_API_KEY;

if (!API_KEY && process.env.AGENT_BROWSER_ALLOW_DEV_KEY !== "true") {
  throw new Error("AGENT_BROWSER_API_KEY is required. Set AGENT_BROWSER_ALLOW_DEV_KEY=true only for local development.");
}

const EFFECTIVE_API_KEY = API_KEY ?? "dev-key";

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
  if (key !== EFFECTIVE_API_KEY) {
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

    // ── Extension WebSocket upgrade ──────────────────────────
    if (path === "/extension/stream" && req.headers.get("upgrade") === "websocket") {
      if (url.searchParams.get("api_key") !== EFFECTIVE_API_KEY) {
        return json({ error: "Invalid API key" }, 401);
      }
      const success = server.upgrade(req, { data: { sessionId: "extension", isExtension: true } as WSData });
      if (success) return undefined as unknown as Response;
      return json({ error: "WebSocket upgrade failed" }, 500);
    }

    // Auth middleware
    const authResult = requireAuth(req);
    if (authResult instanceof Response) return authResult;

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

    // ── Job Queue ──────────────────────────────────────────────────────────

    // POST /jobs — submit async agent job
    if (path === "/jobs" && req.method === "POST") {
      const body = await readBody<{
        type?: "run" | "plan";
        goal: string;
        site_url?: string;
        max_steps?: number;
        provider?: string;
        model?: string;
        api_key?: string;
        webhook_url?: string;
        headless?: boolean;
      }>(req);
      if (!body.goal) return json({ error: "Missing 'goal'" }, 400);

      const job = createJob({
        type: "run",
        goal: body.goal,
        site: body.site_url,
        config: { max_steps: body.max_steps, provider: body.provider, model: body.model },
        webhook_url: body.webhook_url,
      });

      // Run job in background
      (async () => {
        updateJob(job.id, { status: "running", started_at: new Date().toISOString() });
        let acquiredSessionId: string | null = null;
        try {
          const session = await pool.acquire({ browser: { headless: body.headless ?? true } });
          acquiredSessionId = session.id;
          if (body.site_url) {
            await executeAction(session, { type: "navigate", url: body.site_url });
          }
          const type = body.type ?? "run";
          let result;
          if (type === "plan") {
                result = await runPlanner(session, {
              goal: body.goal, max_subtasks: body.max_steps,
              provider: body.provider as any, model: body.model, api_key: body.api_key,
              job_id: job.id,
            });
          } else {
                result = await runAgentLoop(session, {
              goal: body.goal, max_steps: body.max_steps ?? 20,
              provider: body.provider as any, model: body.model, api_key: body.api_key,
              site_url: body.site_url,
            });
          }
          updateJob(job.id, { status: result.success ? "done" : "failed", result: result as unknown as Record<string, unknown>, finished_at: new Date().toISOString(), error: result.error });
          if (body.webhook_url) {
            fetch(body.webhook_url, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ event: "job_complete", job_id: job.id, status: result.success ? "done" : "failed", result }) }).catch(() => {});
          }
        } catch (err) {
          updateJob(job.id, { status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() });
        } finally {
          if (acquiredSessionId) pool.release(acquiredSessionId);
        }
      })();

      return json({ job_id: job.id, status: "queued" }, 202);
    }

    // GET /jobs — list jobs
    if (path === "/jobs" && req.method === "GET") {
      const status = new URL(req.url).searchParams.get("status") as JobStatus | null;
      return json({ jobs: listJobs(status ?? undefined) });
    }

    // GET /jobs/:id — get job status + result
    if (path.startsWith("/jobs/") && req.method === "GET" && !path.includes("/resolve")) {
      const id = path.slice("/jobs/".length);
      const job = getJob(id);
      if (!job) return json({ error: "Job not found" }, 404);
      return json(job);
    }

    // DELETE /jobs/:id — cancel job
    if (path.startsWith("/jobs/") && req.method === "DELETE") {
      const id = path.slice("/jobs/".length);
      const cancelled = cancelJob(id);
      return cancelled ? json({ status: "cancelled" }) : json({ error: "Job not found or already finished" }, 404);
    }

    // POST /jobs/:id/resolve — HITL: human submits resolution
    if (path.match(/^\/jobs\/[^/]+\/resolve$/) && req.method === "POST") {
      const id = path.split("/")[2]!;
      const body = await readBody<{ resolution: string }>(req);
      if (!body.resolution) return json({ error: "Missing 'resolution'" }, 400);
      const resolved = resolveHITL(id, body.resolution);
      return resolved ? json({ status: "resolved" }) : json({ error: "Job not waiting for HITL" }, 400);
    }

    // ── Chrome Pool ─────────────────────────────────────────────────────────

    // GET /pool — pool stats
    if (path === "/pool" && req.method === "GET") {
      return json(pool.stats());
    }

    // ── Iframe actions ───────────────────────────────────────────────────────

    // POST /session/:id/iframe/fill — fill input inside iframe
    // Handled below in session subpaths

    // GET /session/:id/context — get cross-page context graph summary
    if (subPath === "/context" && req.method === "GET") {
      const ctx = session.contextGraph?.getContext();
      return json({
        current: ctx?.current,
        history: ctx?.history,
        breadcrumb: ctx?.breadcrumb,
        summary: session.contextGraph?.getWorkflowSummary(),
        total_pages: session.contextGraph?.nodes.size ?? 0,
      });
    }

    // GET /session/:id/events — get page events (modal, auth challenge, error, captcha)
    if (subPath === "/events" && req.method === "GET") {
      const pending_only = new URL(req.url).searchParams.get("pending") === "true";
      const ev = pending_only ? session.events?.getPending() : session.events?.events;
      return json({ events: ev ?? [], pending: session.events?.getPending()?.length ?? 0 });
    }

    // DELETE /session/:id/events — clear event history
    if (subPath === "/events" && req.method === "DELETE") {
      session.events?.clear();
      return json({ status: "cleared" });
    }

    // GET /session/:id/graph/diffs — get semantic diffs since timestamp
    if (subPath.startsWith("/graph/diffs") && req.method === "GET") {
      const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
      const diffs = session.liveGraph?.getDiffs(since) ?? [];
      return json({ diffs, mutation_count: session.liveGraph?.mutation_count ?? 0, last_full_extract: session.liveGraph?.last_full_extract ?? 0 });
    }

    // POST /session/:id/recover — attempt recovery for a failed action
    if (subPath === "/recover" && req.method === "POST") {
      const body = await readBody<{ action: string; error?: string }>(req);
      try {
        const { recover } = await import("./recovery.ts");
        const action = JSON.parse(body.action);
        const result = await recover(session, {
          original_action: action,
          original_error: body.error,
          pre_url: session.pageModel?.page.url ?? "",
          attempt_count: 1,
        });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/trace/start — enable action tracing for this session
    if (subPath === "/trace/start" && req.method === "POST") {
      session.tracingEnabled = true;
      createTracer(sessionId);
      return json({ status: "tracing", session_id: sessionId });
    }

    // POST /session/:id/trace/stop — disable tracing
    if (subPath === "/trace/stop" && req.method === "POST") {
      session.tracingEnabled = false;
      getTracer(sessionId)?.flush();
      return json({ status: "stopped", session_id: sessionId });
    }

    // GET /session/:id/trace — get trace entries for this session
    if (subPath === "/trace" && req.method === "GET") {
      const traceDir = pathJoin2(homedir2(), ".agent-browser", "traces", sessionId);
      try {
        const files = readdirSync(traceDir).filter((f: string) => f.endsWith(".jsonl"));
        const entries = files.flatMap((f: string) =>
          readFileSync(pathJoin2(traceDir, f), "utf8")
            .split("
").filter(Boolean)
            .map((line: string) => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean)
        );
        return json({ session_id: sessionId, entries, count: entries.length });
      } catch {
        return json({ session_id: sessionId, entries: [], count: 0 });
      }
    }

    // GET /memory — list all learned site memories
    if (path === "/memory" && req.method === "GET") {
      return json({ memories: listMemories() });
    }

    // GET /memory/:host — get memory for a site
    if (path.startsWith("/memory/") && req.method === "GET") {
      const host = path.slice("/memory/".length);
      return json(loadSiteMemory(host));
    }

    // DELETE /memory/:host — clear memory for a site
    if (path.startsWith("/memory/") && req.method === "DELETE") {
      const host = path.slice("/memory/".length);
      const p = pathJoin(homedir(), ".agent-browser", "memory", `${host.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
      if (fsExistsSync(p)) { unlinkSync(p); return json({ status: "deleted" }); }
      return json({ error: "Memory not found" }, 404);
    }

    // ── Skills ────────────────────────────────────────────────────────────────

    // GET /skills — list all skills (builtin + custom)
    if (path === "/skills" && req.method === "GET") {
      const site = new URL(req.url).searchParams.get("site") ?? undefined;
      return json({ skills: listSkills(site) });
    }

    // GET /skills/:name — get skill details
    if (path.startsWith("/skills/") && req.method === "GET") {
      const name = decodeURIComponent(path.slice("/skills/".length));
      const skill = loadSkill(name);
      return skill ? json(skill) : json({ error: "Skill not found" }, 404);
    }

    // POST /skills — save a custom skill
    if (path === "/skills" && req.method === "POST") {
      const body = await readBody<any>(req);
      if (!body.name || !body.site) return json({ error: "Missing name or site" }, 400);
      saveSkill({ ...body, created_at: new Date().toISOString(), source: "custom" });
      return json({ status: "saved", name: body.name });
    }

    // POST /skills/:name/run — run a skill in a session
    if (path.match(/^\/skills\/[^/]+\/run$/) && req.method === "POST") {
      const skillName = decodeURIComponent(path.split("/")[2]!);
      const body = await readBody<{ session_id: string; params?: Record<string, string> }>(req);
      if (!body.session_id) return json({ error: "Missing session_id" }, 400);
      const session = getSession(body.session_id);
      if (!session) return json({ error: "Session not found" }, 404);
      const skill = loadSkill(skillName);
      if (!skill) return json({ error: `Skill "${skillName}" not found` }, 404);
      try {
        const steps = resolveSkill(skill, body.params ?? {});
        const results = [];
        for (const step of steps) {
          const stepResults = [];
          for (const action of step.actions) {
            const result = await executeAction(session, action);
            stepResults.push(result);
            if (!result.success) { results.push({ step: step.description, results: stepResults, failed: true }); break; }
          }
          results.push({ step: step.description, results: stepResults, failed: false });
        }
        incrementUseCount(skillName);
        const allOk = results.every((r) => !r.failed);
        return json({ success: allOk, skill: skillName, results });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ── Audit Logs ────────────────────────────────────────────────────────────

    // GET /audit/:org — read audit log
    if (path.match(/^\/audit\/[^/]+$/) && req.method === "GET") {
      const orgId = path.split("/")[2]!;
      const params = new URL(req.url).searchParams;
      const entries = readAuditLog(orgId, {
        date: params.get("date") ?? undefined,
        session_id: params.get("session_id") ?? undefined,
        severity: (params.get("severity") ?? undefined) as any,
        limit: Number(params.get("limit") ?? 100),
      });
      return json({ entries, count: entries.length });
    }

    // ── Credential Vault ─────────────────────────────────────────────────────

    // GET /vault/:org — list stored credentials (no passwords returned)
    if (path.match(/^\/vault\/[^/]+$/) && req.method === "GET") {
      const orgId = path.split("/")[2]!;
      try {
        return json({ credentials: await vaultList(orgId) });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /vault/:org — store credential (encrypted)
    if (path.match(/^\/vault\/[^/]+$/) && req.method === "POST") {
      const orgId = path.split("/")[2]!;
      const body = await readBody<{ site: string; username?: string; password?: string; totp_secret?: string; api_key?: string }>(req);
      if (!body.site) return json({ error: "Missing site" }, 400);
      try {
        await vaultSet(orgId, body.site, body);
        return json({ status: "stored", site: body.site });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /vault/:org/:site — retrieve credential
    if (path.match(/^\/vault\/[^/]+\/[^/]+$/) && req.method === "GET") {
      const parts = path.split("/");
      const orgId = parts[2]!;
      const site = parts[3]!;
      try {
        const cred = await vaultGet(orgId, site);
        if (!cred) return json({ error: "Credential not found" }, 404);
        // Never return raw password — return masked version + TOTP if applicable
        return json({
          site: cred.site,
          username: cred.username,
          has_password: !!cred.password,
          totp_code: cred.totp_secret ? generateTOTP(cred.totp_secret) : undefined,
          api_key: cred.api_key,
          updated_at: cred.updated_at,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // DELETE /vault/:org/:site — delete credential
    if (path.match(/^\/vault\/[^/]+\/[^/]+$/) && req.method === "DELETE") {
      const parts = path.split("/");
      const [,, orgId, site] = parts;
      try {
        const deleted = await vaultDelete(orgId!, site!);
        return deleted ? json({ status: "deleted" }) : json({ error: "Not found" }, 404);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // ── Workflows ────────────────────────────────────────────────────────────

    // GET /workflows — list saved workflows
    if (path === "/workflows" && req.method === "GET") {
      return json({ workflows: listWorkflows() });
    }

    // POST /workflows — create/save a workflow
    if (path === "/workflows" && req.method === "POST") {
      try {
        const body = await readBody<{ name: string; site: string; nodes: any[]; edges?: any[] }>(req);
        if (!body.name || !body.site) return json({ error: "Missing name or site" }, 400);
        const graph = { id: `${body.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`, name: body.name, site: body.site, nodes: body.nodes ?? [], edges: body.edges ?? [], created_at: new Date().toISOString(), version: 1 };
        saveWorkflow(graph);
        return json({ workflow_id: graph.id, status: "saved" });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // GET /workflows/:id — get workflow
    if (path.startsWith("/workflows/") && req.method === "GET") {
      const id = path.slice("/workflows/".length);
      const graph = loadWorkflow(id);
      return graph ? json(graph) : json({ error: "Workflow not found" }, 404);
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
      session.siteUrl = body.url;
      const result = await executeAction(session, { type: "navigate", url: body.url });
      if (result.success) {
        const model = await refreshPageModel(session);

        // Auto-login: if login form detected + auth configured for this site
        if (session.authHandler) {
          const loginForm = session.authHandler.detectLoginForm(model);
          if (loginForm) {
            const siteHost = new URL(body.url).hostname;
            const authResult = await session.authHandler.authenticate(model, siteHost, session.cdp);
            if (authResult.success) {
              const freshModel = await refreshPageModel(session);
              return json({ status: "navigated", page: freshModel, auto_login: true });
            }
          }
        }

        // Auto-captcha: if CAPTCHA detected + resolver configured
        if (session.captchaResolver) {
          const detected = session.captchaResolver.detectCaptcha(model);
          if (detected) {
            const captchaResult = await session.captchaResolver.resolve(model, body.url);
            if (captchaResult.solved && captchaResult.token) {
              // Inject token into page
              await session.cdp.evaluate(`
                const el = document.getElementById('g-recaptcha-response') || document.querySelector('[name="g-recaptcha-response"]');
                if (el) el.value = ${JSON.stringify(captchaResult.token)};
              `);
              const freshModel = await refreshPageModel(session);
              return json({ status: "navigated", page: freshModel, captcha_solved: true });
            }
          }
        }

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
        confidence: result.confidence,
        strategy: result.strategy,
        verification: (result as any).verification,
        page: session.pageModel,
      });
    }

    // POST /session/:id/auth/configure — store credentials for auto-login
    if (subPath === "/auth/configure" && req.method === "POST") {
      const body = await readBody<{
        site?: string;
        username?: string;
        password?: string;
        totp_secret?: string;
        mfa_type?: "totp" | "sms" | "none";
        captcha_key?: string;
        captcha_service?: "2captcha" | "anti-captcha" | "capsolver";
      }>(req);
      if (!session.authHandler) session.authHandler = new SemanticAuthHandler();
      const site = body.site ?? (session.pageModel?.page.url ? new URL(session.pageModel.page.url).hostname : "default");
      session.authHandler.configure(site, {
        username: body.username,
        password: body.password,
        totpSecret: body.totp_secret,
      }, body.mfa_type);
      if (body.captcha_key) {
        session.captchaResolver = new SemanticCaptchaResolver({
          apiKey: body.captcha_key,
          service: body.captcha_service ?? "2captcha",
        });
      }
      session.siteUrl = body.site;
      return json({ status: "configured", site });
    }

    // POST /session/:id/auth/login — trigger auto-login on current page
    if (subPath === "/auth/login" && req.method === "POST") {
      try {
        if (!session.authHandler) return json({ error: "No auth configured. Call /auth/configure first." }, 400);
        const page = await refreshPageModel(session);
        const site = session.siteUrl ?? new URL(page.page.url).hostname;
        const result = await session.authHandler.authenticate(page, site, session.cdp);
        if (result.success) {
          await refreshPageModel(session);
        }
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/workflow/run — execute a saved workflow DAG
    if (subPath.startsWith("/workflow/run") && req.method === "POST") {
      const body = await readBody<{ workflow_id: string; resume_from?: string }>(req);
      if (!body.workflow_id) return json({ error: "Missing workflow_id" }, 400);
      try {
        const run = await executeWorkflow(session, body.workflow_id, body.resume_from, (nodeId, status) => {
          console.log(`[workflow] ${nodeId}: ${status}`);
        });
        return json(run);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/create-plan — planner only (returns typed plan without executing)
    if (subPath === "/create-plan" && req.method === "POST") {
      const body = await readBody<{ goal: string; provider?: string; model?: string; api_key?: string }>(req);
      if (!body.goal) return json({ error: "Missing goal" }, 400);
      try {
        const page = await refreshPageModel(session);
        const plan = await createPlan(body.goal, page, {
          provider: body.provider as any, model: body.model, api_key: body.api_key,
        });
        return json(plan);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/execute-plan — executor only (runs a pre-built plan)
    if (subPath === "/execute-plan" && req.method === "POST") {
      const body = await readBody<{ plan: any; stop_on_low_confidence?: number }>(req);
      if (!body.plan) return json({ error: "Missing plan" }, 400);
      try {
        const result = await executePlan(session, body.plan, {
          stop_on_low_confidence: body.stop_on_low_confidence,
          on_step: (step, result) => console.log(`[executor] ${step.id}: ${result.status}`),
        });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/plan — task planner (goal → subtasks → execute)
    if (subPath === "/plan" && req.method === "POST") {
      const body = await readBody<{
        goal: string;
        max_subtasks?: number;
        provider?: "gemini" | "openai" | "anthropic";
        model?: string;
        api_key?: string;
        webhook_url?: string;
      }>(req);
      if (!body.goal) return json({ error: "Missing 'goal'" }, 400);
      try {
        const result = await runPlanner(session, {
          goal: body.goal,
          max_subtasks: body.max_subtasks ?? 8,
          provider: body.provider,
          model: body.model,
          api_key: body.api_key,
        });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/iframe/fill — fill input inside an iframe
    if (subPath.startsWith("/iframe/fill") && req.method === "POST") {
      const body = await readBody<{ iframe_src: string; selector: string; value: string }>(req);
      try {
        await session.cdp.fillInIframe(body.iframe_src, body.selector, body.value);
        return json({ success: true });
      } catch (err) {
        return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/iframe/click — click element inside an iframe
    if (subPath.startsWith("/iframe/click") && req.method === "POST") {
      const body = await readBody<{ iframe_src: string; selector: string }>(req);
      try {
        await session.cdp.clickInIframe(body.iframe_src, body.selector);
        return json({ success: true });
      } catch (err) {
        return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/iframe/eval — evaluate JS inside an iframe
    if (subPath.startsWith("/iframe/eval") && req.method === "POST") {
      const body = await readBody<{ iframe_src: string; expression: string }>(req);
      try {
        const result = await session.cdp.evaluateInIframe(body.iframe_src, body.expression);
        return json({ success: true, result });
      } catch (err) {
        return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/run — autonomous LLM agent loop
    if (subPath === "/run" && req.method === "POST") {
      const body = await readBody<{
        goal: string;
        max_steps?: number;
        provider?: "gemini" | "openai" | "anthropic";
        model?: string;
        api_key?: string;
        async?: boolean;
        webhook_url?: string;
        planner?: boolean;
      }>(req);
      if (!body.goal) return json({ error: "Missing 'goal'" }, 400);
      if (body.async) {
        const job = createJob({
          type: "run",
          session_id: session.id,
          goal: body.goal,
          webhook_url: body.webhook_url,
          config: {
            max_steps: body.max_steps,
            provider: body.provider,
            model: body.model,
            api_key: body.api_key,
            planner: body.planner,
          },
        });
        (async () => {
          updateJob(job.id, { status: "running", started_at: new Date().toISOString() });
          try {
            const result = body.planner
              ? await runPlanner(session, {
                  goal: body.goal,
                  max_subtasks: body.max_steps,
                  provider: body.provider,
                  model: body.model,
                  api_key: body.api_key,
                  job_id: job.id,
                })
              : await runAgentLoop(session, {
                  goal: body.goal,
                  max_steps: body.max_steps ?? 20,
                  provider: body.provider,
                  model: body.model,
                  api_key: body.api_key,
                  site_url: session.pageModel?.page.url,
                });
            updateJob(job.id, { status: result.success ? "done" : "failed", result: result as unknown as Record<string, unknown>, finished_at: new Date().toISOString(), error: result.error });
            if (body.webhook_url) {
              fetch(body.webhook_url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event: "job_complete", job_id: job.id, status: result.success ? "done" : "failed", result }),
              }).catch(() => {});
            }
          } catch (err) {
            updateJob(job.id, { status: "failed", error: err instanceof Error ? err.message : String(err), finished_at: new Date().toISOString() });
          }
        })();
        return json({ job_id: job.id, status: job.status }, 202);
      }
      try {
        const result = await runAgentLoop(session, {
          goal: body.goal,
          max_steps: body.max_steps ?? 20,
          provider: body.provider,
          model: body.model,
          api_key: body.api_key,
          site_url: session.pageModel?.page.url,
        });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /session/:id/vision — screenshot + LLM vision → suggested actions
    if (subPath === "/vision" && req.method === "POST") {
      try {
        const body = await readBody<{ intent: string; provider?: string; api_key?: string }>(req);
        if (!body.intent) return json({ error: "Missing 'intent'" }, 400);
        const screenshot = await session.cdp.screenshot(false);
        const apiKey = body.api_key ?? process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY;
        if (!apiKey) return json({ error: "Vision requires GEMINI_API_KEY or OPENAI_API_KEY" }, 400);

        const prompt = `You are a browser vision assistant. Look at this screenshot and the user intent: "${body.intent}"\n\nReturn a JSON array of semantic actions to accomplish this intent. Use ONLY these action types:\n- {"type":"click","target":"visible label"}\n- {"type":"fill","form":"formId","field":"fieldName","value":"text"}\n- {"type":"click_selector","selector":"css"}\n- {"type":"fill_selector","selector":"css","value":"text"}\n- {"type":"press","key":"Enter"}\n- {"type":"scroll","direction":"down"}\n\nReturn ONLY valid JSON array. No explanation.`;

        let responseText = "";
        if (process.env.GEMINI_API_KEY) {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: screenshot } }] }] }) });
          const data = await res.json() as any;
          responseText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
        } else {
          const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${screenshot}` } }
            ]}] })
          });
          const data = await res.json() as any;
          responseText = data.choices?.[0]?.message?.content ?? "[]";
        }

        const match = responseText.match(/\[[\s\S]*\]/);
        const actions = match ? JSON.parse(match[0]) : [];
        return json({ intent: body.intent, suggested_actions: actions });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
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
      if (process.env.AGENT_BROWSER_ENABLE_EVALUATE !== "true") {
        return json({ error: "Page evaluation is disabled. Set AGENT_BROWSER_ENABLE_EVALUATE=true to enable it." }, 403);
      }
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
console.log(``);
console.log(`Agent Intelligence:`);
console.log(`  POST   /session/:id/run                — Autonomous LLM ReAct agent loop`);
console.log(`    { goal, max_steps?, provider?, model?, api_key?, async?, planner?, webhook_url? }`);
console.log(`  POST   /jobs                           — Submit async run/do job`);
console.log(`  GET    /jobs, /jobs/:id                — List or inspect jobs`);
console.log(`  DELETE /jobs/:id                       — Cancel queued/running job`);
console.log(`  POST   /jobs/:id/hitl                  — Resume job waiting for human input`);
console.log(`  POST   /session/:id/auth/configure     — Store credentials for auto-login`);
console.log(`    { site?, username, password, totp_secret?, mfa_type?, captcha_key? }`);
console.log(`  POST   /session/:id/auth/login         — Trigger auto-login on current page`);
console.log(`  POST   /session/:id/vision             — Screenshot + LLM vision → actions`);
console.log(`    { intent, provider?, api_key? }`);
console.log(`  GET    /memory                         — List learned site memories`);
console.log(`  GET    /memory/:host                   — Get memory for a site`);
console.log(`  DELETE /memory/:host                   — Clear memory for a site`);
