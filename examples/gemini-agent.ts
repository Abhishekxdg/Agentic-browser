#!/usr/bin/env bun
// Gemini agentic loop — runs tasks using your semantic agent-browser

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, readdirSync } from "fs";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error("GEMINI_API_KEY not set"); process.exit(1); }

const MODEL = "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
const MAX_TURNS = 40;
const BROWSER_BASE = "http://localhost:3001";
const BROWSER_KEY = process.env.AGENT_BROWSER_API_KEY ?? "dev-key";

const task = process.argv.slice(2).join(" ");
if (!task) { console.error("Usage: bun gemini-agent.ts <task description>"); process.exit(1); }

// ── Browser API helpers ────────────────────────────────────────────────────

let sessionId: string | null = null;

async function browserFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BROWSER_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${BROWSER_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function isBrowserRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BROWSER_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function startBrowserServer(): Promise<void> {
  const cwd = import.meta.dir;
  const proc = spawn("bun", ["src/agent-browser/server.ts"], {
    cwd, detached: true, stdio: "ignore",
    env: { ...process.env, AGENT_BROWSER_API_KEY: BROWSER_KEY, AGENT_BROWSER_ALLOW_DEV_KEY: "true" },
  });
  proc.unref();
  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isBrowserRunning()) return;
  }
  throw new Error("Browser server failed to start after 10s");
}

// ── Tool implementations ───────────────────────────────────────────────────

async function toolBrowserStart(args: { headless?: boolean }): Promise<string> {
  if (!(await isBrowserRunning())) {
    console.error("[browser] starting server...");
    await startBrowserServer();
    console.error("[browser] server ready");
  }
  const data = await browserFetch("POST", "/session", { headless: args.headless ?? true }) as any;
  if (data.session_id) {
    sessionId = data.session_id;
    return `Session created: ${sessionId}`;
  }
  return `Error: ${JSON.stringify(data)}`;
}

async function toolBrowserNavigate(args: { url: string }): Promise<string> {
  if (!sessionId) return "ERROR: no session. Call browser_start first.";
  const data = await browserFetch("POST", `/session/${sessionId}/navigate`, { url: args.url }) as any;
  if (data.status === "navigated") {
    const page = data.page;
    return `Navigated to ${page?.page?.url ?? args.url}\nTitle: ${page?.page?.title ?? "?"}\nForms: ${JSON.stringify(page?.forms?.map((f: any) => ({ id: f.id, purpose: f.purpose, fields: f.fields?.map((x: any) => x.name) })))}`;
  }
  return `Error: ${JSON.stringify(data)}`;
}

async function toolBrowserPage(): Promise<string> {
  if (!sessionId) return "ERROR: no session.";
  const data = await browserFetch("GET", `/session/${sessionId}/page`) as any;
  const page = data.page;
  if (!page) return `Error: ${JSON.stringify(data)}`;
  return JSON.stringify({
    url: page.page?.url,
    title: page.page?.title,
    forms: page.forms,
    interactive: page.interactive?.slice(0, 20),
    content: page.content?.slice(0, 5),
    dialogs: page.dialogs,
  }, null, 2);
}

async function toolBrowserAction(args: { action: string }): Promise<string> {
  if (!sessionId) return "ERROR: no session.";
  let action: unknown;
  try { action = JSON.parse(args.action); }
  catch { return `ERROR: invalid JSON: ${args.action}`; }
  const data = await browserFetch("POST", `/session/${sessionId}/action`, action) as any;
  if (data.success) {
    const page = data.page;
    const summary = page ? `\nPage: ${page.page?.title} @ ${page.page?.url}\nForms: ${JSON.stringify(page.forms?.map((f: any) => ({ id: f.id, purpose: f.purpose, fields: f.fields?.map((x: any) => x.name) })))}` : "";
    return `OK${data.data ? `: ${JSON.stringify(data.data)}` : ""}${summary}`;
  }
  return `FAILED: ${data.error ?? JSON.stringify(data)}`;
}

async function toolBrowserJs(args: { expression: string }): Promise<string> {
  if (!sessionId) return "ERROR: no session.";
  const data = await browserFetch("POST", `/session/${sessionId}/evaluate`, { expression: args.expression }) as any;
  if (data.success) return `Result: ${JSON.stringify(data.result)}`;
  return `FAILED: ${data.error}`;
}

async function toolBrowserActions(args: { actions: string }): Promise<string> {
  if (!sessionId) return "ERROR: no session.";
  let actions: unknown[];
  try { actions = JSON.parse(args.actions); }
  catch { return `ERROR: invalid JSON`; }
  const data = await browserFetch("POST", `/session/${sessionId}/actions`, { actions }) as any;
  const failed = data.results?.find((r: any) => !r.success);
  if (failed) return `FAILED at action: ${failed.error}`;
  const page = data.page;
  return `All actions OK. Page: ${page?.page?.title} @ ${page?.page?.url}`;
}

async function toolBrowserScreenshot(): Promise<string> {
  if (!sessionId) return "ERROR: no session.";
  const path = `/tmp/gemini-browser-${Date.now()}.png`;
  try {
    const res = await fetch(`${BROWSER_BASE}/session/${sessionId}/screenshot`, {
      headers: { "Authorization": `Bearer ${BROWSER_KEY}` },
    });
    if (!res.ok) return `Screenshot failed: ${res.status}`;
    const buf = await res.arrayBuffer();
    writeFileSync(path, Buffer.from(buf));
    return `Screenshot saved: ${path}`;
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

// ── Standard tools ─────────────────────────────────────────────────────────

function runBash(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, cwd: process.cwd() }) || "(empty)";
  } catch (e: any) {
    return `EXIT ${e.status ?? 1}\n${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

// ── Gemini tool definitions ────────────────────────────────────────────────

const TOOLS = [{
  functionDeclarations: [
    {
      name: "browser_start",
      description: "Start the agent browser server and create a browser session. Call this first before any browser action.",
      parameters: {
        type: "OBJECT",
        properties: { headless: { type: "BOOLEAN", description: "Run headless (default true)" } },
        required: []
      }
    },
    {
      name: "browser_navigate",
      description: "Navigate to a URL. Returns the semantic page model with forms, fields, buttons.",
      parameters: {
        type: "OBJECT",
        properties: { url: { type: "STRING", description: "Full URL to navigate to" } },
        required: ["url"]
      }
    },
    {
      name: "browser_page",
      description: "Get the current semantic page model. Shows forms, fields, buttons, interactive elements.",
      parameters: { type: "OBJECT", properties: {}, required: [] }
    },
    {
      name: "browser_action",
      description: `Execute a single semantic browser action. Pass action as JSON string.
Action types:
- fill: {"type":"fill","form":"formId","field":"fieldName","value":"text"}
- click: {"type":"click","target":"Button text or label"}
- click_text: {"type":"click_text","text":"exact visible text"}
- click_selector: {"type":"click_selector","selector":"css selector"}
- fill_selector: {"type":"fill_selector","selector":"css selector","value":"text"}
- type_text: {"type":"type_text","text":"text to type after focusing"}
- press: {"type":"press","key":"Enter"}
- wait: {"type":"wait","condition":"network.idle","ms":2000}
- wait_for: {"type":"wait_for","selector":"css selector"}
- scroll: {"type":"scroll","direction":"down"}
- handle_dialog: {"type":"handle_dialog","accept":true}
- navigate: {"type":"navigate","url":"https://..."}`,
      parameters: {
        type: "OBJECT",
        properties: { action: { type: "STRING", description: "Action as JSON string" } },
        required: ["action"]
      }
    },
    {
      name: "browser_js",
      description: "Execute arbitrary JavaScript in the current browser page. Use for tricky interactions: finding elements, clicking by partial text, reading values, etc. Example: document.querySelector('button').click()",
      parameters: {
        type: "OBJECT",
        properties: { expression: { type: "STRING", description: "JS expression to evaluate in the page" } },
        required: ["expression"]
      }
    },
    {
      name: "browser_actions",
      description: "Execute multiple browser actions in sequence. Pass as JSON array string.",
      parameters: {
        type: "OBJECT",
        properties: { actions: { type: "STRING", description: "Array of action objects as JSON string" } },
        required: ["actions"]
      }
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot. Returns the path to the saved PNG file.",
      parameters: { type: "OBJECT", properties: {}, required: [] }
    },
    {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "OBJECT",
        properties: { command: { type: "STRING" } },
        required: ["command"]
      }
    },
    {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "OBJECT",
        properties: { path: { type: "STRING" } },
        required: ["path"]
      }
    },
    {
      name: "write_file",
      description: "Write a file.",
      parameters: {
        type: "OBJECT",
        properties: { path: { type: "STRING" }, content: { type: "STRING" } },
        required: ["path", "content"]
      }
    },
    {
      name: "done",
      description: "Signal task completion with a summary.",
      parameters: {
        type: "OBJECT",
        properties: { summary: { type: "STRING" } },
        required: ["summary"]
      }
    }
  ]
}];

// ── Tool dispatch ──────────────────────────────────────────────────────────

async function runTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "browser_start":     return await toolBrowserStart(args);
      case "browser_navigate":  return await toolBrowserNavigate(args as { url: string });
      case "browser_page":      return await toolBrowserPage();
      case "browser_action":    return await toolBrowserAction(args as { action: string });
      case "browser_js":        return await toolBrowserJs(args as { expression: string });
      case "browser_actions":   return await toolBrowserActions(args as { actions: string });
      case "browser_screenshot": return await toolBrowserScreenshot();
      case "bash":              return runBash(args.command);
      case "read_file":         return readFileSync(args.path, "utf8");
      case "write_file":        writeFileSync(args.path, args.content, "utf8"); return `Wrote ${args.path}`;
      default:                  return `Unknown tool: ${name}`;
    }
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

// ── Gemini API call ────────────────────────────────────────────────────────

async function callGemini(messages: any[]): Promise<any> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: `You are a browser automation agent. Complete tasks ONLY using the provided tools. NEVER write Python/Node/shell scripts to solve browser problems.

RULES:
1. Call browser_start first (always)
2. Use browser_navigate to load URLs
3. Use browser_page to see page structure (forms, fields, buttons)
4. Use browser_action for fill/click/press/wait actions
5. When browser_action fails, try browser_js to run JS directly in the page
6. Use browser_screenshot to capture evidence
7. Call done when task is complete

WHEN STUCK on a click/button:
- Try browser_js: document.querySelector('button') or find buttons by text with Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('text'))?.click()
- Try click_selector with different CSS selectors
- Try click_coords with x/y coordinates from the page

NEVER write files, NEVER use bash to run scripts. Only use the browser_* tools.
CWD: ${process.cwd()}` }]
      },
      contents: messages,
      tools: TOOLS,
      tool_config: { function_calling_config: { mode: "AUTO" } },
      generation_config: { temperature: 0.1 }
    })
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  console.error(`[gemini-agent] task: ${task}`);
  const messages: any[] = [{ role: "user", parts: [{ text: task }] }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callGemini(messages);
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error("No candidate");

    const content = candidate.content;
    messages.push(content);

    const fnCalls = (content.parts ?? []).filter((p: any) => p.functionCall);

    if (fnCalls.length === 0) {
      const text = (content.parts ?? []).filter((p: any) => p.text).map((p: any) => p.text).join("\n");
      if (text) console.log(text);
      break;
    }

    const fnResponses: any[] = [];
    for (const part of content.parts) {
      if (!part.functionCall) continue;
      const { name, args } = part.functionCall;
      console.error(`[tool:${name}] ${JSON.stringify(args).slice(0, 150)}`);

      if (name === "done") { console.log(args.summary); process.exit(0); }

      const result = await runTool(name, args ?? {});
      fnResponses.push({ functionResponse: { name, response: { result } } });
    }

    messages.push({ role: "user", parts: fnResponses });
  }
}

main().catch(e => { console.error("[gemini-agent] fatal:", e.message); process.exit(1); });
