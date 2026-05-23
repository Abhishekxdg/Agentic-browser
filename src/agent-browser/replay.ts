import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createSession, executeAction, getSession, type BrowserSession } from "./session-manager.ts";
import type { SemanticAction } from "./action-resolver.ts";

export interface ReplayStep {
  index: number;
  action: SemanticAction;
  success: boolean;
  error?: string;
  elapsed_ms: number;
}

export interface ReplayResult {
  session_id: string;
  source_trace_session_id?: string;
  success: boolean;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  duration_ms: number;
  steps: ReplayStep[];
}

interface TraceLike {
  action?: SemanticAction;
}

function traceDir(sessionId: string): string {
  return join(homedir(), ".sound-browser", "traces", sessionId);
}

export function readTraceActions(sessionId: string): SemanticAction[] {
  const dir = traceDir(sessionId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  return files.flatMap((file) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as TraceLike; }
        catch { return null; }
      })
      .filter((entry): entry is TraceLike => !!entry?.action)
      .map((entry) => entry.action!),
  );
}

export async function replayActions(
  actions: SemanticAction[],
  opts: { session?: BrowserSession; sessionId?: string; stopOnFailure?: boolean; sourceTraceSessionId?: string } = {},
): Promise<ReplayResult> {
  let session = opts.session ?? (opts.sessionId ? getSession(opts.sessionId) : undefined);
  if (!session) session = await createSession({ browser: { headless: true } });

  const started = Date.now();
  const steps: ReplayStep[] = [];

  for (const [index, action] of actions.entries()) {
    const stepStart = Date.now();
    const result = await executeAction(session, action);
    steps.push({
      index,
      action,
      success: result.success,
      error: result.error,
      elapsed_ms: Date.now() - stepStart,
    });
    if (!result.success && opts.stopOnFailure !== false) break;
  }

  const passed = steps.filter((s) => s.success).length;
  return {
    session_id: session.id,
    source_trace_session_id: opts.sourceTraceSessionId,
    success: steps.length === actions.length && steps.every((s) => s.success),
    total_steps: actions.length,
    passed_steps: passed,
    failed_steps: steps.length - passed,
    duration_ms: Date.now() - started,
    steps,
  };
}

export async function replayTrace(
  traceSessionId: string,
  opts: { sessionId?: string; stopOnFailure?: boolean } = {},
): Promise<ReplayResult> {
  const actions = readTraceActions(traceSessionId);
  if (actions.length === 0) throw new Error(`No trace actions found for session ${traceSessionId}`);
  return replayActions(actions, {
    sessionId: opts.sessionId,
    stopOnFailure: opts.stopOnFailure,
    sourceTraceSessionId: traceSessionId,
  });
}
