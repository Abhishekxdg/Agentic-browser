/**
 * Session Manager
 * Manages browser sessions, multi-tab support, cookies, and auth state.
 * Each session owns a CDPBridge instance.
 */

import { CDPBridge, type CDPBrowserConfig, type TabInfo } from "./cdp-bridge.ts";
import { extractSemanticPage, type SemanticPage } from "./semantic-page.ts";
import { executeSemanticAction, type SemanticAction, type ActionResult } from "./action-resolver.ts";
import type { StreamObserver } from "./stream-observer.ts";

export interface SessionConfig {
  browser?: CDPBrowserConfig;
}

export interface BrowserSession {
  id: string;
  cdp: CDPBridge;
  createdAt: Date;
  lastActive: Date;
  pageModel: SemanticPage | null;
  streamObserver?: StreamObserver;
}

const sessions = new Map<string, BrowserSession>();

function makeId(): string {
  return `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Create a new browser session and launch Chromium */
export async function createSession(config: SessionConfig = {}): Promise<BrowserSession> {
  const id = makeId();
  const cdp = new CDPBridge(config.browser);
  await cdp.launch();

  const session: BrowserSession = {
    id,
    cdp,
    createdAt: new Date(),
    lastActive: new Date(),
    pageModel: null,
  };

  sessions.set(id, session);
  return session;
}

/** Get an existing session by ID */
export function getSession(id: string): BrowserSession | undefined {
  return sessions.get(id);
}

/** Refresh the semantic page model for a session */
export async function refreshPageModel(session: BrowserSession): Promise<SemanticPage> {
  const model = await extractSemanticPage(session.cdp);
  session.pageModel = model;
  session.lastActive = new Date();
  return model;
}

/** Execute a semantic action in a session */
export async function executeAction(
  session: BrowserSession,
  action: SemanticAction,
): Promise<ActionResult> {
  if (!session.pageModel && action.type !== "navigate") {
    await refreshPageModel(session);
  }
  const result = await executeSemanticAction(session.cdp, session.pageModel!, action);

  if (action.type === "navigate" || action.type === "click" || action.type === "press" || action.type === "fill") {
    try {
      await refreshPageModel(session);
    } catch {
      // Page may not have loaded yet
    }
  } else {
    session.lastActive = new Date();
  }

  return result;
}

/** Close a session and kill its Chrome process */
export async function closeSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;

  await session.cdp.kill();
  sessions.delete(id);
  return true;
}

/** List all active sessions */
export function listSessions(): Array<{ id: string; createdAt: string; lastActive: string; connected: boolean }> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    lastActive: s.lastActive.toISOString(),
    connected: s.cdp.isConnected,
  }));
}

/** List all tabs in a session */
export async function listTabs(session: BrowserSession): Promise<TabInfo[]> {
  return session.cdp.listTabs();
}

/** Open a new tab in a session, optionally navigate to url. Returns new tab id. */
export async function openTab(session: BrowserSession, url?: string): Promise<string> {
  const tabId = await session.cdp.openTab(url);
  session.pageModel = null;
  session.lastActive = new Date();
  return tabId;
}

/** Switch active tab in a session. Clears pageModel (caller must refresh). */
export async function switchTab(session: BrowserSession, tabId: string): Promise<void> {
  await session.cdp.switchTab(tabId);
  session.pageModel = null;
  session.lastActive = new Date();
}

/** Close a tab in a session. If active tab closed, CDPBridge auto-switches to another. */
export async function closeTab(session: BrowserSession, tabId: string): Promise<void> {
  await session.cdp.closeTab(tabId);
  session.pageModel = null;
  session.lastActive = new Date();
}

/** Cleanup stale sessions (call periodically) */
export async function cleanupStaleSessions(maxIdleMs = 30 * 60 * 1000): Promise<number> {
  const now = Date.now();
  const stale = Array.from(sessions.keys()).filter(
    (id) => now - sessions.get(id)!.lastActive.getTime() > maxIdleMs,
  );
  await Promise.all(stale.map((id) => closeSession(id)));
  return stale.length;
}
