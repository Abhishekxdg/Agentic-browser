import { createSession, closeSession, executeAction } from "./session-manager.ts";
import type { SemanticAction } from "./action-resolver.ts";
import { replayActions } from "./replay.ts";

export interface EvalCase {
  name: string;
  site?: string;
  actions: SemanticAction[];
  checks?: Array<{ name: string; expression: string; expected?: unknown }>;
}

export interface EvalCaseResult {
  name: string;
  success: boolean;
  action_success_rate: number;
  latency_ms: number;
  hallucination_rate: number;
  checks: Array<{ name: string; passed: boolean; actual?: unknown; error?: string }>;
  replay: Awaited<ReturnType<typeof replayActions>>;
}

export interface EvalRunResult {
  success: boolean;
  cases: EvalCaseResult[];
  summary: {
    total_cases: number;
    passed_cases: number;
    reliability_score: number;
    action_success_rate: number;
    avg_latency_ms: number;
    hallucination_rate: number;
  };
}

function looksHallucinated(step: { success: boolean; error?: string }): boolean {
  if (step.success) return false;
  const err = (step.error ?? "").toLowerCase();
  return /not found|no .*match|unknown action|invalid selector|cannot resolve|could not find/.test(err);
}

export async function runEvalCases(cases: EvalCase[]): Promise<EvalRunResult> {
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    const session = await createSession({ browser: { headless: true } });
    const started = Date.now();
    const checks: EvalCaseResult["checks"] = [];

    try {
      if (evalCase.site) {
        await executeAction(session, { type: "navigate", url: evalCase.site }, { refresh: false });
      }

      const replay = await replayActions(evalCase.actions, { session, stopOnFailure: true });

      for (const check of evalCase.checks ?? []) {
        try {
          const actual = await session.cdp.evaluate(check.expression);
          const passed = "expected" in check ? actual === check.expected : Boolean(actual);
          checks.push({ name: check.name, passed, actual });
        } catch (err) {
          checks.push({ name: check.name, passed: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const attempted = Math.max(1, replay.steps.length);
      const actionSuccessRate = replay.steps.filter((s) => s.success).length / attempted;
      const hallucinationRate = replay.steps.filter(looksHallucinated).length / attempted;
      const checkSuccess = checks.length === 0 || checks.every((c) => c.passed);

      results.push({
        name: evalCase.name,
        success: replay.success && checkSuccess,
        action_success_rate: actionSuccessRate,
        latency_ms: Date.now() - started,
        hallucination_rate: hallucinationRate,
        checks,
        replay,
      });
    } catch (err) {
      results.push({
        name: evalCase.name,
        success: false,
        action_success_rate: 0,
        latency_ms: Date.now() - started,
        hallucination_rate: 0,
        checks: [{ name: "eval error", passed: false, error: err instanceof Error ? err.message : String(err) }],
        replay: {
          session_id: session.id,
          success: false,
          total_steps: evalCase.actions.length,
          passed_steps: 0,
          failed_steps: evalCase.actions.length,
          duration_ms: Date.now() - started,
          steps: [],
        },
      });
    } finally {
      await closeSession(session.id).catch(() => {});
    }
  }

  const totalCases = results.length || 1;
  const totalSteps = results.reduce((sum, r) => sum + Math.max(1, r.replay.steps.length), 0) || 1;
  const passedSteps = results.reduce((sum, r) => sum + r.replay.steps.filter((s) => s.success).length, 0);

  return {
    success: results.every((r) => r.success),
    cases: results,
    summary: {
      total_cases: results.length,
      passed_cases: results.filter((r) => r.success).length,
      reliability_score: results.filter((r) => r.success).length / totalCases,
      action_success_rate: passedSteps / totalSteps,
      avg_latency_ms: results.reduce((sum, r) => sum + r.latency_ms, 0) / totalCases,
      hallucination_rate: results.reduce((sum, r) => sum + r.hallucination_rate, 0) / totalCases,
    },
  };
}
