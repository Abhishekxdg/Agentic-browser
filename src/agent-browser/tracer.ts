/**
 * Action Trace Recorder — records every action with screenshots, page snapshots, timing.
 * Feeds debugging, replay, training data, and evals.
 * Stored to ~/.agent-browser/traces/<session_id>/<timestamp>.jsonl
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, appendFileSync } from "fs";
import type { SemanticAction, ActionResult } from "./action-resolver.ts";
import type { SemanticPage } from "./semantic-page.ts";
import type { VerificationResult } from "./verifier.ts";

export interface TraceEntry {
  session_id: string;
  step: number;
  timestamp: string;
  elapsed_ms: number;
  action: SemanticAction;
  result: ActionResult;
  verification?: VerificationResult;
  page_before?: { url: string; title: string; form_count: number; interactive_count: number };
  page_after?: { url: string; title: string; form_count: number; interactive_count: number };
  screenshot_before?: string; // base64 png
  screenshot_after?: string;
}

export interface Tracer {
  record(entry: Omit<TraceEntry, "session_id" | "step" | "timestamp">): void;
  flush(): void;
  path: string;
}

const TRACES_DIR = join(homedir(), ".agent-browser", "traces");
const _tracerCache = new Map<string, Tracer>();

function pageSnapshot(page: SemanticPage) {
  return {
    url: page.page.url,
    title: page.page.title,
    form_count: page.forms.length,
    interactive_count: page.interactive.length,
  };
}

export function createTracer(sessionId: string): Tracer {
  const dir = join(TRACES_DIR, sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `trace-${Date.now()}.jsonl`);
  let step = 0;

  const tracer: Tracer = {
    path,
    record(entry) {
      step++;
      const full: TraceEntry = {
        session_id: sessionId,
        step,
        timestamp: new Date().toISOString(),
        ...entry,
      };
      appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
    },
    flush() {
      _tracerCache.delete(sessionId);
    },
  };

  _tracerCache.set(sessionId, tracer);
  return tracer;
}

export function getTracer(sessionId: string): Tracer | null {
  return _tracerCache.get(sessionId) ?? null;
}

// Compact page summary for trace (avoids storing entire page model)
export function compactPage(page: SemanticPage | null | undefined) {
  if (!page) return undefined;
  return pageSnapshot(page);
}
