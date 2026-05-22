/**
 * Recovery Engine — structured failure handling for agent actions.
 * Backtracking, rollback, dead-end detection, alternative strategy selection.
 */

import type { BrowserSession } from "./session-manager.ts";
import { executeAction, refreshPageModel } from "./session-manager.ts";
import type { SemanticAction, ActionResult } from "./action-resolver.ts";
import type { VerificationResult } from "./verifier.ts";

export type RecoveryStrategy =
  | "retry_same"
  | "retry_with_wait"
  | "try_aria_label"
  | "try_visible_text"
  | "try_selector"
  | "try_js_eval"
  | "scroll_into_view"
  | "close_dialog"
  | "handle_overlay"
  | "rollback_navigate"
  | "escalate";

export interface RecoveryAttempt {
  strategy: RecoveryStrategy;
  action: SemanticAction;
  result: ActionResult;
  succeeded: boolean;
}

export interface RecoveryResult {
  recovered: boolean;
  attempts: RecoveryAttempt[];
  final_error?: string;
  escalated: boolean;
}

export interface RecoveryContext {
  original_action: SemanticAction;
  original_error?: string;
  verification?: VerificationResult;
  pre_url: string;
  attempt_count: number;
}

// Dead-end detection: track (url, action_type) pairs seen N times
const _stateHistory = new Map<string, number>();

export function recordState(sessionId: string, url: string, actionType: string): void {
  const key = `${sessionId}:${url}:${actionType}`;
  _stateHistory.set(key, (_stateHistory.get(key) ?? 0) + 1);
}

export function isDeadEnd(sessionId: string, url: string, actionType: string, threshold = 3): boolean {
  const key = `${sessionId}:${url}:${actionType}`;
  return (_stateHistory.get(key) ?? 0) >= threshold;
}

export function clearHistory(sessionId: string): void {
  for (const key of _stateHistory.keys()) {
    if (key.startsWith(`${sessionId}:`)) _stateHistory.delete(key);
  }
}

// Build recovery plan from failure context
function buildRecoveryPlan(ctx: RecoveryContext, session: BrowserSession): Array<{ strategy: RecoveryStrategy; action: SemanticAction }> {
  const original = ctx.original_action;
  const plans: Array<{ strategy: RecoveryStrategy; action: SemanticAction }> = [];

  // If a dialog is blocking, dismiss it first
  const page = session.pageModel;
  if (page?.dialogs?.length) {
    plans.push({
      strategy: "close_dialog",
      action: { type: "handle_dialog", accept: false },
    });
  }

  // Action-specific recovery strategies
  if (original.type === "click") {
    const target = original.target;

    // Retry with wait
    plans.push({ strategy: "retry_with_wait", action: { type: "wait", condition: "network.idle", ms: 2000 } });

    // Try aria label
    plans.push({ strategy: "try_aria_label", action: { type: "click_selector", selector: `[aria-label="${target}"], [title="${target}"]` } });

    // Try visible text
    plans.push({ strategy: "try_visible_text", action: { type: "click_text", text: target } });

    // Scroll element into view then retry
    plans.push({ strategy: "scroll_into_view", action: { type: "scroll", direction: "down" } });
    plans.push({ strategy: "retry_same", action: original });

    // JS eval fallback
    plans.push({
      strategy: "try_js_eval",
      action: { type: "evaluate", expression: `Array.from(document.querySelectorAll('button,a,[role=button]')).find(el => el.textContent?.trim().toLowerCase().includes(${JSON.stringify(target.toLowerCase())}))?.click()` } as any,
    });
  }

  if (original.type === "fill" || original.type === "fill_selector") {
    const field = (original as any).field ?? (original as any).selector ?? "";
    const value = (original as any).value ?? "";

    plans.push({ strategy: "retry_with_wait", action: { type: "wait", condition: "network.idle", ms: 1500 } });
    plans.push({ strategy: "try_selector", action: { type: "fill_selector", selector: `input[name="${field}"], input[id="${field}"], [placeholder="${field}"]`, value } });
    plans.push({ strategy: "try_aria_label", action: { type: "fill_selector", selector: `[aria-label="${field}"]`, value } });
    plans.push({
      strategy: "try_js_eval",
      action: { type: "evaluate", expression: `(function(){ const el = document.querySelector('input[name="${field}"],input[id="${field}"]'); if(el){ el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; } return false; })()` } as any,
    });
  }

  if (original.type === "navigate") {
    plans.push({ strategy: "retry_same", action: original });
  }

  // If nothing else, rollback to pre-action URL
  if (ctx.pre_url && ctx.pre_url !== "about:blank") {
    plans.push({ strategy: "rollback_navigate", action: { type: "navigate", url: ctx.pre_url } });
  }

  plans.push({ strategy: "escalate", action: original }); // sentinel
  return plans;
}

export async function recover(
  session: BrowserSession,
  ctx: RecoveryContext,
  maxAttempts = 4,
): Promise<RecoveryResult> {
  const page = session.pageModel;
  const url = page?.page?.url ?? ctx.pre_url;

  // Dead-end check before attempting recovery
  if (isDeadEnd(session.id, url, ctx.original_action.type)) {
    return { recovered: false, attempts: [], final_error: `Dead end: stuck on ${url} doing ${ctx.original_action.type} ${ctx.attempt_count}+ times`, escalated: true };
  }

  const plan = buildRecoveryPlan(ctx, session);
  const attempts: RecoveryAttempt[] = [];
  let recovered = false;

  for (const step of plan.slice(0, maxAttempts)) {
    if (step.strategy === "escalate") {
      return { recovered: false, attempts, final_error: ctx.original_error, escalated: true };
    }

    // Execute wait steps silently (they always succeed)
    if (["retry_with_wait", "scroll_into_view"].includes(step.strategy)) {
      await executeAction(session, step.action);
      // After wait/scroll, retry the original action
      const retryResult = await executeAction(session, ctx.original_action);
      attempts.push({ strategy: step.strategy, action: ctx.original_action, result: retryResult, succeeded: retryResult.success });
      if (retryResult.success) { recovered = true; break; }
      continue;
    }

    const result = await executeAction(session, step.action);
    attempts.push({ strategy: step.strategy, action: step.action, result, succeeded: result.success });

    if (result.success && step.strategy !== "rollback_navigate") {
      recovered = true;
      break;
    }
  }

  recordState(session.id, url, ctx.original_action.type);
  return { recovered, attempts, escalated: !recovered };
}
