import { HybridExecutionEngine, type HybridEngineConfig } from "../executor/hybrid-engine.ts";
import { SessionRecorder } from "../recorder/session-recorder.ts";
import type { ApiGraph } from "../graph/types.ts";

// Prevent Bun from crashing on unhandled rejections from Playwright
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.message);
});

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.AGENT_BROWSER_API_KEY ?? "dev-key";

// In-memory storage for Phase 1
const graphs = new Map<string, ApiGraph>();
const engines = new Map<string, HybridExecutionEngine>();

function getEngine(apiKey: string): HybridExecutionEngine {
  if (!engines.has(apiKey)) {
    const config: HybridEngineConfig = {
      browser: { headless: process.env.HEADLESS !== "false" },
      vision: process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY, provider: "openai", model: "gpt-4o" }
        : undefined,
      captcha: process.env.CAPTCHA_API_KEY
        ? { apiKey: process.env.CAPTCHA_API_KEY, service: "2captcha" }
        : undefined,
    };
    engines.set(apiKey, new HybridExecutionEngine(config));
  }
  return engines.get(apiKey)!;
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return json({ status: "ok", version: "0.1.0" });
    }

    // Auth middleware
    const authResult = requireAuth(req);
    if (authResult instanceof Response) return authResult;

    // Execute intent
    if (path === "/v1/execute" && req.method === "POST") {
      const body = await readBody<{ site: string; intent: string; graph_id?: string; auth?: { username: string; password: string; totp_secret?: string; mfa_type?: "totp" | "sms" | "none" } }>(req);

      if (!body.site || !body.intent) {
        return json({ error: "Missing 'site' or 'intent'" }, 400);
      }

      try {
        const engine = getEngine(authResult);

        if (body.auth) {
          engine.configureAuth(body.site, {
            username: body.auth.username,
            password: body.auth.password,
            totpSecret: body.auth.totp_secret,
          }, body.auth.mfa_type);
        }

        const graph = body.graph_id ? graphs.get(body.graph_id) : undefined;
        const result = await engine.execute(body.site, body.intent, graph);

        return json({
          status: result.status,
          data: result.data,
          screenshot: result.screenshot,
          steps_executed: result.steps_executed,
          strategy_used: result.strategy_used,
          error: result.error,
          reasoning: result.reasoning,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // Configure auth
    if (path === "/v1/auth" && req.method === "POST") {
      const body = await readBody<{ site: string; credentials: { username: string; password: string; totp_secret?: string }; mfa_type?: "totp" | "sms" | "none" }>(req);

      if (!body.site || !body.credentials) {
        return json({ error: "Missing 'site' or 'credentials'" }, 400);
      }

      const engine = getEngine(authResult);
      engine.configureAuth(body.site, body.credentials, body.mfa_type);

      return json({ status: "configured", site: body.site });
    }

    // Record workflow
    if (path === "/v1/record" && req.method === "POST") {
      const body = await readBody<{ site: string; action: "begin" | "end"; name?: string }>(req);

      if (!body.site || !body.action) {
        return json({ error: "Missing 'site' or 'action'" }, 400);
      }

      // For recording, we return a WebSocket URL or session ID
      // Phase 1: simplified — just acknowledge
      return json({
        status: "recording_not_implemented_in_rest",
        message: "Use the SDK SessionRecorder for interactive recording. See docs.",
      });
    }

    // Upload graph
    if (path === "/v1/graph" && req.method === "POST") {
      const body = await readBody<{ graph_id: string; graph: ApiGraph }>(req);

      if (!body.graph_id || !body.graph) {
        return json({ error: "Missing 'graph_id' or 'graph'" }, 400);
      }

      graphs.set(body.graph_id, body.graph);
      return json({ status: "stored", graph_id: body.graph_id, nodes: body.graph.nodes.size });
    }

    // Debug: inspect detected elements on a page
    if (path === "/v1/debug/elements" && req.method === "POST") {
      const body = await readBody<{ site: string; intent: string }>(req);
      const { StealthBrowser } = await import("../core/browser.ts");
      const { DomController } = await import("../core/dom-controller.ts");
      const browser = new StealthBrowser({ headless: true });
      try {
        const page = await browser.newPageFresh();
        try { await page.goto(body.site, { waitUntil: "networkidle", timeout: 12000 }); }
        catch { await page.goto(body.site, { waitUntil: "domcontentloaded", timeout: 15000 }); }
        const ctrl = new DomController();
        const elements = await ctrl.detectElements(page, body.intent);
        return json({ elements, url: page.url(), title: await page.title() });
      } finally {
        await browser.close();
      }
    }

    // Not found
    return json({ error: "Not found" }, 404);
  },
});

console.log(`Agent Browser API running at http://localhost:${server.port}`);
