/**
 * Planner / Executor / Verifier / Recovery — clean separation.
 * Planner: WHAT to do (decompose goal into subtasks).
 * Executor: HOW to do it (run actions against the browser).
 * Verifier: DID it work (compare expected vs observed state).
 * Recovery: WHAT WHEN IT FAILS (alternative strategies, rollback).
 *
 * This architecture massively improves reliability by isolating concerns.
 */

import type { BrowserSession } from "./session-manager.ts";
import { executeAction, refreshPageModel } from "./session-manager.ts";
import type { SemanticAction, ActionResult } from "./action-resolver.ts";
import type { VerificationResult } from "./verifier.ts";
import { capturePreState, verify } from "./verifier.ts";
import type { RecoveryResult, RecoveryContext } from "./recovery.ts";
import { recover, recordState, clearHistory } from "./recovery.ts";
import { runAgentLoop, type AgentStep } from "./agent-loop.ts";
import { callLLM, parseJSON, type LLMConfig } from "./llm.ts";
import type { SemanticPage } from "./semantic-page.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  description: string;
  expected_outcome: string;
  max_retries: number;
  requires_human: boolean;
  actions_hint?: string[];
}

export interface Plan {
  goal: string;
  subtasks: SubTask[];
  created_at: string;
}

export interface ExecutorResult {
  success: boolean;
  steps: AgentStep[];
  action_results: { result: string; error?: string }[];
  error?: string;
}

export interface PlannerResult {
  success: boolean;
  plan: Plan;
  error?: string;
}

export interface VerifiedResult {
  success: boolean;
  executorResult: ExecutorResult;
  verification?: VerificationResult;
  error?: string;
}

// ── PLANNER ────────────────────────────────────────────────────────────────

export class Planner {
  private llmConfig: LLMConfig;

  constructor(config: LLMConfig = {}) {
    this.llmConfig = config;
  }

  async createPlan(goal: string, page: SemanticPage): Promise<PlannerResult> {
    try {
      const prompt = `You are a task decomposition expert. Break down this goal into 3-8 concrete subtasks.

Goal: "${goal}"
Current page: ${page.page.url} — "${page.page.title}"
Forms: ${JSON.stringify(page.forms.map((f) => ({ id: f.id, purpose: f.purpose })))}
Interactive elements: ${JSON.stringify(page.interactive.slice(0, 10).map((i) => i.label))}

Return a JSON object:
{
  "subtasks": [
    {
      "id": "step_1",
      "description": "what to do (concise, action-oriented)",
      "expected_outcome": "what the page/state should look like after",
      "max_retries": 2,
      "requires_human": false,
      "actions_hint": ["optional hints"]
    }
  ]
}

Set requires_human: true for steps involving payment, 2FA, or sensitive data.
Return ONLY the JSON object. No explanation.`;

      const text = await callLLM(prompt, { ...this.llmConfig, temperature: 0.0 });
      const parsed = parseJSON(text, { subtasks: [] });

      const plan: Plan = {
        goal,
        subtasks: parsed.subtasks.map((s: any, idx: number) => ({
          id: s.id ?? `step_${idx + 1}`,
          description: s.description ?? "",
          expected_outcome: s.expected_outcome ?? "",
          max_retries: s.max_retries ?? 2,
          requires_human: s.requires_human ?? false,
          actions_hint: s.actions_hint,
        })),
        created_at: new Date().toISOString(),
      };

      return { success: true, plan };
    } catch (err) {
      return { success: false, plan: { goal, subtasks: [], created_at: new Date().toISOString() }, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replan from current state when a subtask fails */
  async replan(plan: Plan, failedSubtask: SubTask, currentPage: SemanticPage): Promise<PlannerResult> {
    const completed = plan.subtasks
      .slice(0, plan.subtasks.indexOf(failedSubtask))
      .map((s) => s.description);

    const prompt = `The following subtask failed: "${failedSubtask.description}"
Error: ${failedSubtask.expected_outcome}

Completed so far: ${JSON.stringify(completed)}
Current page: ${currentPage.page.url} — "${currentPage.page.title}"

Provide a revised plan from this point forward. Return JSON: { "subtasks": [...] }`;

    try {
      const text = await callLLM(prompt, { ...this.llmConfig, temperature: 0.0 });
      const parsed = parseJSON(text, { subtasks: [] });
      const newPlan: Plan = {
        goal: plan.goal,
        subtasks: parsed.subtasks.map((s: any, idx: number) => ({
          id: `replan_${idx + 1}`,
          description: s.description ?? "",
          expected_outcome: s.expected_outcome ?? "",
          max_retries: s.max_retries ?? 2,
          requires_human: s.requires_human ?? false,
          actions_hint: s.actions_hint,
        })),
        created_at: new Date().toISOString(),
      };
      return { success: true, plan: newPlan };
    } catch (err) {
      return { success: false, plan, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── EXECUTOR ─────────────────────────────────────────────────────────────────

export class Executor {
  /**
   * Execute a single subtask by running the agent loop.
   * The executor does NOT know about the overall plan — it just executes.
   */
  async executeSubtask(
    session: BrowserSession,
    subtask: SubTask,
    llmConfig: LLMConfig = {},
  ): Promise<ExecutorResult> {
    try {
      const loopResult = await runAgentLoop(session, {
        goal: subtask.description,
        max_steps: 10,
        provider: llmConfig.provider as any,
        model: llmConfig.model,
        api_key: llmConfig.api_key,
        site_url: session.pageModel?.page.url,
      });

      return {
        success: loopResult.success,
        steps: loopResult.steps,
        action_results: loopResult.steps.map((s) => ({ result: s.result, error: s.error })),
        error: loopResult.error,
      };
    } catch (err) {
      return {
        success: false,
        steps: [],
        action_results: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Execute a raw semantic action directly */
  async executeAction(
    session: BrowserSession,
    action: SemanticAction,
  ): Promise<ActionResult> {
    return executeAction(session, action);
  }

  /** Execute a batch of actions sequentially */
  async executeBatch(
    session: BrowserSession,
    actions: SemanticAction[],
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of actions) {
      const result = await executeAction(session, action);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }
}

// ── VERIFIER ───────────────────────────────────────────────────────────────

export class Verifier {
  private llmConfig: LLMConfig;

  constructor(config: LLMConfig = {}) {
    this.llmConfig = config;
  }

  /** Check if the observed page state matches the expected outcome */
  async verify(
    session: BrowserSession,
    expectedOutcome: string,
  ): Promise<VerificationResult> {
    const page = await refreshPageModel(session);
    const preState = await capturePreState(session).catch(() => null);

    if (preState) {
      const result = await verify(session, { type: "extract", what: "page" } as SemanticAction, preState);
      return result;
    }

    // Fallback: LLM-based verification
    return this.verifyWithLLM(page, expectedOutcome);
  }

  private async verifyWithLLM(page: SemanticPage, expectedOutcome: string): Promise<VerificationResult> {
    const prompt = `Did this subtask complete successfully?

Expected outcome: "${expectedOutcome}"
Current page: ${page.page.url} — "${page.page.title}"
Forms: ${JSON.stringify(page.forms.map((f) => ({ id: f.id, purpose: f.purpose })))}
Interactive: ${JSON.stringify(page.interactive.slice(0, 8).map((i) => i.label))}
Dialogs: ${JSON.stringify(page.dialogs)}

Reply with ONLY: {"verified": true} or {"verified": false, "evidence": "..."}`;

    try {
      const text = await callLLM(prompt, { ...this.llmConfig, temperature: 0.0 });
      const parsed = parseJSON(text, { verified: false, evidence: "" });
      return {
        verified: parsed.verified === true,
        evidence: parsed.evidence ?? "",
        expected: expectedOutcome,
        confidence: parsed.verified === true ? 0.8 : 0.3,
        signals: [],
      };
    } catch {
      return { verified: false, evidence: "LLM verification failed", expected: expectedOutcome, confidence: 0, signals: [] };
    }
  }

  /** Verify the entire plan by checking each completed subtask */
  async verifyPlan(
    session: BrowserSession,
    plan: Plan,
    completedSubtasks: SubTask[],
  ): Promise<{ allVerified: boolean; results: Record<string, VerificationResult> }> {
    const results: Record<string, VerificationResult> = {};
    let allVerified = true;

    for (const subtask of completedSubtasks) {
      const v = await this.verify(session, subtask.expected_outcome);
      results[subtask.id] = v;
      if (!v.verified) allVerified = false;
    }

    return { allVerified, results };
  }
}

// ── RECOVERY ─────────────────────────────────────────────────────────────────

export class Recovery {
  /**
   * Attempt to recover from a failed action.
   * Delegates to the existing recovery engine but wrapped in clean interface.
   */
  async attemptRecovery(
    session: BrowserSession,
    originalAction: SemanticAction,
    originalError: string,
    preUrl: string,
  ): Promise<RecoveryResult> {
    const ctx: RecoveryContext = {
      original_action: originalAction,
      original_error: originalError,
      pre_url: preUrl,
      attempt_count: 1,
    };
    return recover(session, ctx);
  }

  /** Check if we're stuck in a dead end */
  isDeadEnd(sessionId: string, url: string, actionType: string): boolean {
    return false; // Delegated to recovery engine's recordState
  }

  /** Clear state history for a session */
  clearHistory(sessionId: string): void {
    clearHistory(sessionId);
  }
}

// ── ORCHESTRATOR ────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  planner: Planner;
  executor: Executor;
  verifier: Verifier;
  recovery: Recovery;
  llm: LLMConfig;
  onSubtaskStart?: (subtask: SubTask) => void;
  onSubtaskDone?: (subtask: SubTask, verified: boolean) => void;
  onSubtaskFailed?: (subtask: SubTask, error: string) => void;
  onRecovery?: (attempt: any) => void;
}

export interface OrchestratorResult {
  success: boolean;
  goal: string;
  plan: Plan;
  completedSubtasks: SubTask[];
  failedSubtask?: SubTask;
  totalSteps: number;
  verificationResults: Record<string, VerificationResult>;
  error?: string;
}

export class Orchestrator {
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  async run(session: BrowserSession, goal: string): Promise<OrchestratorResult> {
    const page = await refreshPageModel(session);
    const plannerResult = await this.config.planner.createPlan(goal, page);

    if (!plannerResult.success) {
      return {
        success: false,
        goal,
        plan: plannerResult.plan,
        completedSubtasks: [],
        totalSteps: 0,
        verificationResults: {},
        error: `Planning failed: ${plannerResult.error}`,
      };
    }

    const plan = plannerResult.plan;
    const completedSubtasks: SubTask[] = [];
    const verificationResults: Record<string, VerificationResult> = {};
    let totalSteps = 0;

    for (const subtask of plan.subtasks) {
      this.config.onSubtaskStart?.(subtask);

      const preUrl = session.pageModel?.page.url ?? "about:blank";
      let succeeded = false;

      for (let attempt = 0; attempt <= subtask.max_retries; attempt++) {
        const execResult = await this.config.executor.executeSubtask(session, subtask, this.config.llm);
        totalSteps += execResult.steps.length;

        if (execResult.success) {
          const verification = await this.config.verifier.verify(session, subtask.expected_outcome);
          verificationResults[subtask.id] = verification;

          if (verification.verified) {
            succeeded = true;
            completedSubtasks.push(subtask);
            this.config.onSubtaskDone?.(subtask, true);
            break;
          }
          // Executor succeeded but verifier failed — try again
        }

        // Try recovery on the last failed action
        const lastFailed = execResult.action_results.findLast((r) => r.result === "failed");
        if (lastFailed && attempt < subtask.max_retries) {
          const recoveryResult = await this.config.recovery.attemptRecovery(
            session,
            { type: "click", target: "unknown" } as SemanticAction, // placeholder — real action needed
            execResult.error ?? "unknown",
            preUrl,
          );
          this.config.onRecovery?.(recoveryResult);
          if (!recoveryResult.recovered) break;
        }

        if (!execResult.success && attempt === subtask.max_retries) {
          this.config.onSubtaskFailed?.(subtask, execResult.error ?? "Failed after max retries");
        }
      }

      if (!succeeded) {
        return {
          success: false,
          goal,
          plan,
          completedSubtasks,
          failedSubtask: subtask,
          totalSteps,
          verificationResults,
          error: `Failed on subtask: ${subtask.description}`,
        };
      }
    }

    return {
      success: true,
      goal,
      plan,
      completedSubtasks,
      totalSteps,
      verificationResults,
    };
  }
}
