import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { readdir, unlink, readFile, writeFile } from "fs/promises";
import type { SemanticPage } from "./semantic-page.ts";
import type { SemanticDiff } from "./semantic-graph.ts";
import type { PageEdge, PageNode } from "./context-graph.ts";
import type { PageEvent } from "./event-awareness.ts";

const SNAPSHOT_DIR = join(homedir(), ".sound-browser", "snapshots");
const PROFILE_RE = /^[a-zA-Z0-9._-]{1,80}$/;

export interface BrowserStateSnapshot {
  profile: string;
  savedAt: string;
  currentUrl?: string;
  activeTabId?: string;
  tabs: Array<{ id: string; url: string; title: string; active: boolean }>;
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: number;
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  semanticPage?: SemanticPage | null;
  semanticGraph?: {
    current?: SemanticPage | null;
    diffs: SemanticDiff[];
    last_full_extract: number;
    mutation_count: number;
  };
  contextGraph?: {
    current_url: string;
    breadcrumb: string[];
    nodes: PageNode[];
    edges: PageEdge[];
  };
  networkState?: {
    events: PageEvent[];
    pending_events: PageEvent[];
    ajax_completed: number;
    auth_challenges: number;
    websocket_messages: number;
    errors: number;
  };
}

function ensureDir(): void {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function profilePath(profile: string): string {
  if (!PROFILE_RE.test(profile) || profile === "." || profile === "..") {
    throw new Error("Invalid snapshot profile. Use 1-80 letters, numbers, dots, underscores, or hyphens.");
  }
  return join(SNAPSHOT_DIR, `${profile}.json`);
}

export async function saveStateSnapshot(snapshot: BrowserStateSnapshot): Promise<void> {
  ensureDir();
  await writeFile(profilePath(snapshot.profile), JSON.stringify(snapshot, null, 2), "utf8");
}

export async function loadStateSnapshot(profile: string): Promise<BrowserStateSnapshot | null> {
  ensureDir();
  const path = profilePath(profile);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as BrowserStateSnapshot;
}

export async function listStateSnapshots(): Promise<string[]> {
  ensureDir();
  const files = await readdir(SNAPSHOT_DIR);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
}

export async function deleteStateSnapshot(profile: string): Promise<boolean> {
  const path = profilePath(profile);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
