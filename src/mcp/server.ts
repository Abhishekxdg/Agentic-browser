/**
 * Agent Browser MCP Server
 * Exposes browser control as MCP tools — works with Claude Desktop, Claude Code,
 * Cursor, and any MCP-compatible agent.
 *
 * Usage:
 *   bun run src/mcp/server.ts
 *
 * Add to Claude Desktop ~/.claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "agent-browser": {
 *         "command": "bun",
 *         "args": ["run", "/path/to/agent-browser/src/mcp/server.ts"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSession,
  closeSession,
  refreshPageModel,
  executeAction,
  getSession,
  listSessions,
} from "../agent-browser/session-manager.ts";
import { saveCookies, loadCookies } from "./cookie-store.ts";

const server = new McpServer({
  name: "agent-browser",
  version: "0.1.0",
});

// Active session for this MCP connection (auto-created on first use)
let activeSessionId: string | null = null;

async function getOrCreateSession(): Promise<string> {
  if (activeSessionId && getSession(activeSessionId)) return activeSessionId;
  const session = await createSession({ browser: { headless: true } });
  activeSessionId = session.id;
  return activeSessionId;
}

// ── Tools ──────────────────────────────────────────────────────────────────

server.tool(
  "navigate",
  "Navigate the browser to a URL. Returns the page structure as JSON (forms, buttons, links, content).",
  { url: z.string().describe("Full URL to navigate to") },
  async ({ url }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    await executeAction(session, { type: "navigate", url });
    const page = await refreshPageModel(session);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          url: page.page.url,
          title: page.page.title,
          forms: page.forms,
          interactive: page.interactive.slice(0, 20),
          navigation: page.navigation.slice(0, 15),
          content: page.content.slice(0, 8),
          dialogs: page.dialogs,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "get_page",
  "Get the current page structure without navigating. Returns forms, buttons, links, content.",
  {},
  async () => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    const page = await refreshPageModel(session);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          url: page.page.url,
          title: page.page.title,
          forms: page.forms,
          interactive: page.interactive.slice(0, 20),
          navigation: page.navigation.slice(0, 15),
          content: page.content.slice(0, 8),
          dialogs: page.dialogs,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "action",
  `Execute a browser action. Action types:
- fill: {"type":"fill","form":"formId","field":"fieldName","value":"text"}
- click: {"type":"click","target":"Button label"}
- click_text: {"type":"click_text","text":"exact visible text"}
- click_selector: {"type":"click_selector","selector":"css selector"}
- fill_selector: {"type":"fill_selector","selector":"css selector","value":"text"}
- press: {"type":"press","key":"Enter"}
- wait: {"type":"wait","condition":"network.idle","ms":2000}
- scroll: {"type":"scroll","direction":"down"}
- handle_dialog: {"type":"handle_dialog","accept":true}
- navigate: {"type":"navigate","url":"https://..."}`,
  { action: z.string().describe("Action as JSON string") },
  async ({ action }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;

    let parsed: any;
    try { parsed = JSON.parse(action); }
    catch { return { content: [{ type: "text", text: `ERROR: invalid JSON — ${action}` }] }; }

    const result = await executeAction(session, parsed);
    return {
      content: [{
        type: "text",
        text: result.success
          ? `OK${result.data ? `: ${JSON.stringify(result.data)}` : ""}${result.error ? ` (${result.error})` : ""}`
          : `FAILED: ${result.error}`,
      }],
    };
  },
);

server.tool(
  "js",
  "Run JavaScript in the current page. Use when actions can't reach an element.",
  { expression: z.string().describe("JavaScript expression to evaluate") },
  async ({ expression }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    try {
      const result = await session.cdp.evaluate(expression);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `ERROR: ${e.message}` }] };
    }
  },
);

server.tool(
  "screenshot",
  "Take a screenshot of the current page. Returns description of what's visible.",
  { save_path: z.string().optional().describe("Optional file path to save PNG") },
  async ({ save_path }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    const data = await session.cdp.screenshot(false);
    const buf = Buffer.from(data, "base64");

    if (save_path) {
      await Bun.write(save_path, buf);
      return { content: [{ type: "text", text: `Screenshot saved to ${save_path} (${buf.length} bytes)` }] };
    }

    return {
      content: [{
        type: "image",
        data,
        mimeType: "image/png",
      }],
    };
  },
);

server.tool(
  "save_auth",
  "Save the current browser cookies to a named profile. Use after logging in so you don't have to log in again.",
  { profile: z.string().describe("Profile name, e.g. 'zoho-mail' or 'github'") },
  async ({ profile }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    const cookies = await session.cdp.getCookies();
    await saveCookies(profile, cookies);
    return { content: [{ type: "text", text: `Saved ${cookies.length} cookies to profile "${profile}"` }] };
  },
);

server.tool(
  "load_auth",
  "Restore cookies from a saved profile. Use at the start of a session to skip login.",
  { profile: z.string().describe("Profile name to restore") },
  async ({ profile }) => {
    const sid = await getOrCreateSession();
    const session = getSession(sid)!;
    const cookies = await loadCookies(profile);
    if (!cookies) return { content: [{ type: "text", text: `Profile "${profile}" not found` }] };

    for (const cookie of cookies) {
      try { await session.cdp.setCookie(cookie); } catch { /* skip expired */ }
    }
    return { content: [{ type: "text", text: `Loaded ${cookies.length} cookies from profile "${profile}"` }] };
  },
);

server.tool(
  "new_session",
  "Create a fresh browser session (new Chrome window). Useful when you need a clean slate.",
  { headless: z.boolean().optional().describe("Run headless (default true)") },
  async ({ headless = true }) => {
    if (activeSessionId) {
      await closeSession(activeSessionId).catch(() => {});
    }
    const session = await createSession({ browser: { headless } });
    activeSessionId = session.id;
    return { content: [{ type: "text", text: `New session: ${session.id}` }] };
  },
);

server.tool(
  "sessions",
  "List all active browser sessions.",
  {},
  async () => {
    const list = listSessions();
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[agent-browser MCP] ready");
