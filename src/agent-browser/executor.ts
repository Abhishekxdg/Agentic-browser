/**
 * Executor — pure action layer. Runs a typed plan step by step.
 * No reasoning, no LLM calls. Just: read step → execute → return result.
 * Works with plans from planner.ts or hand-crafted plans.
 */

import type { BrowserSession } from "./session-manager.ts";
import { executeAction, refreshPageModel } from "./session-manager.ts";
import { capturePreState, verify } from "./verifier.ts";
import { recover } from "./recovery.ts";
import type { ExecutionPlan, PlanStep } from "./planner.ts";

export type StepResult = {
  step_id: string;
  status: "done" | "failed" | "skipped" | "branched";
  action_result?: { success: boolean; confidence?: number; strategy?: string; error?: string };
  verification?: { verified: boolean; evidence: string };
  next_step?: string;   // for branch steps
  error?: string;
  elapsed_ms: number;
};

export interface ExecutorResult {
  success: boolean;
  goal: string;
  steps_completed: number;
  steps_total: number;
  results: StepResult[];
  error?: string;
  final_url?: string;
}

export async function executePlan(
  session: BrowserSession,
  plan: ExecutionPlan,
  opts: {
    on_step?: (step: PlanStep, result: StepResult) => void;
    max_recovery_attempts?: number;
    stop_on_low_confidence?: number; // threshold below which to pause (0 = never stop)
  } = {},
): Promise<ExecutorResult> {
  const results: StepResult[] = [];
  const maxRecovery = opts.max_recovery_attempts ?? 3;
  let currentStepIdx = 0;
  const stepMap = new Map(plan.steps.map((s) => [s.id, s]));

  while (currentStepIdx < plan.steps.length) {
    const step = plan.steps[currentStepIdx];
    if (!step) break;

    const start = Date.now();

    // Low-confidence pause point
    if (opts.stop_on_low_confidence && (step.confidence ?? 1) < opts.stop_on_low_confidence) {
      const result: StepResult = {
        step_id: step.id, status: "skipped",
        error: `Confidence ${step.confidence} below threshold ${opts.stop_on_low_confidence}`,
        elapsed_ms: 0,
      };
      results.push(result);
      opts.on_step?.(step, result);
      break;
    }

    let result: StepResult;

    try {
      result = await executeStep(session, step, maxRecovery);
    } catch (err) {
      result = {
        step_id: step.id, status: "failed",
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: Date.now() - start,
      };
    }

    result.elapsed_ms = Date.now() - start;
    results.push(result);
    opts.on_step?.(step, result);

    if (result.status === "failed") {
      return {
        success: false,
        goal: plan.goal,
        steps_completed: results.filter((r) => r.status === "done").length,
        steps_total: plan.steps.length,
        results,
        error: `Failed at ${step.id}: ${result.error}`,
        final_url: session.pageModel?.page.url,
      };
    }

    // Branch: jump to specific step
    if (result.status === "branched" && result.next_step) {
      const targetIdx = plan.steps.findIndex((s) => s.id === result.next_step);
      if (targetIdx !== -1) { currentStepIdx = targetIdx; continue; }
    }

    currentStepIdx++;
  }

  return {
    success: true,
    goal: plan.goal,
    steps_completed: results.filter((r) => r.status === "done").length,
    steps_total: plan.steps.length,
    results,
    final_url: session.pageModel?.page.url,
  };
}

async function executeStep(
  session: BrowserSession,
  step: PlanStep,
  maxRecovery: number,
): Promise<StepResult> {
  const base: StepResult = { step_id: step.id, status: "done", elapsed_ms: 0 };

  switch (step.type) {
    case "action": {
      if (!step.action) return { ...base, status: "skipped" };
      const pre = await capturePreState(session).catch(() => null);
      const result = await executeAction(session, step.action);

      if (!result.success) {
        // Try recovery before failing
        const recovery = await recover(session, {
          original_action: step.action,
          original_error: result.error,
          pre_url: session.pageModel?.page.url ?? "",
          attempt_count: 1,
        }, maxRecovery);

        if (!recovery.recovered) {
          return { ...base, status: "failed", action_result: { ...result }, error: result.error };
        }
      }

      // Verify after critical actions
      let verificationResult: { verified: boolean; evidence: string } | undefined;
      if (pre && step.verify_condition) {
        const v = await verify(session, step.action, pre).catch(() => null);
        if (v) verificationResult = { verified: v.verified, evidence: v.evidence };
      }

      return { ...base, status: "done", action_result: { success: true, confidence: result.confidence, strategy: result.strategy }, verification: verificationResult };
    }

    case "wait": {
      const action = step.wait_condition === "network.idle"
        ? { type: "wait" as const, condition: "network.idle" as const, ms: step.wait_ms ?? 3000 }
        : step.wait_condition === "element" && step.wait_selector
          ? { type: "wait_for" as const, selector: step.wait_selector, timeoutMs: step.wait_ms ?? 10000 }
          : { type: "wait" as const, condition: "time" as const, ms: step.wait_ms ?? 1000 };
      await executeAction(session, action);
      return { ...base, status: "done" };
    }

    case "verify": {
      const page = await refreshPageModel(session);
      const condMet = await session.cdp.evaluate(
        `(function() { try { return !!(${step.verify_condition ?? "true"}); } catch { return false; } })()`
      ).catch(() => false) as boolean;
      if (!condMet) {
        return { ...base, status: "failed", error: `Verification failed: ${step.verify_condition}` };
      }
      return { ...base, status: "done", verification: { verified: true, evidence: `Condition met: ${step.verify_condition}` } };
    }

    case "branch": {
      if (!step.branch_condition) return { ...base, status: "done" };
      const result = await session.cdp.evaluate(
        `(function() { try { return !!(${step.branch_condition}); } catch { return false; } })()`
      ).catch(() => false) as boolean;
      const next = result ? step.branch_true : step.branch_false;
      return { ...base, status: "branched", next_step: next };
    }

    case "decision":
      return { ...base, status: "done" };

    default:
      return { ...base, status: "skipped" };
  }
}
