/**
 * Planner — pure reasoning layer. Generates a typed execution plan from a goal + page state.
 * Separated from execution so plan can be inspected, modified, or replayed before running.
 *
 * Architecture:
 *   Planner → Plan → Executor → Verifier → (Recovery if needed)
 */

import type { SemanticPage } from "./semantic-page.ts";
import type { SemanticAction } from "./action-resolver.ts";
import { callLLM, detectProvider, parseJSON, type LLMConfig } from "./llm.ts";

export type StepType = "action" | "wait" | "verify" | "decision" | "branch";

export interface PlanStep {
  id: string;
  type: StepType;
  description: string;
  action?: SemanticAction;
  wait_condition?: "network.idle" | "element" | "time";
  wait_ms?: number;
  wait_selector?: string;
  verify_condition?: string;   // natural language verification condition
  branch_condition?: string;   // JS expression → true/false
  branch_true?: string;        // step id to go to if true
  branch_false?: string;       // step id to go to if false
  confidence?: number;         // planner's confidence this step is correct
  reasoning?: string;          // why this step
}

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  estimated_steps: number;
  assumptions: string[];       // what the planner assumed
  risks: string[];             // where it might fail
  created_at: string;
  provider_used: string;
}

export async function createPlan(
  goal: string,
  page: SemanticPage,
  config: LLMConfig & { history?: string[] } = {},
): Promise<ExecutionPlan> {
  const provider = config.provider ?? detectProvider(config.api_key);

  const historyContext = config.history?.length
    ? `\nRecent actions taken:\n${config.history.slice(-5).map((h, i) => `${i + 1}. ${h}`).join("\n")}`
    : "";

  const prompt = `You are a browser automation planner. Create a step-by-step execution plan to achieve the goal.

Goal: "${goal}"
Current page: ${page.page.url} — "${page.page.title}"
Available forms: ${JSON.stringify(page.forms.map((f) => ({ id: f.id, purpose: f.purpose, fields: f.fields.map((fld) => fld.name) })))}
Available interactions: ${JSON.stringify(page.interactive.slice(0, 10).map((i) => i.label))}
Active dialogs: ${JSON.stringify(page.dialogs.map((d) => d.title ?? d.message))}${historyContext}

Return a JSON plan:
{
  "steps": [
    {
      "id": "step_1",
      "type": "action|wait|verify|decision|branch",
      "description": "human-readable description",
      "action": { ...SemanticAction },       // for type=action
      "wait_condition": "network.idle",       // for type=wait
      "wait_ms": 2000,
      "verify_condition": "login succeeded", // for type=verify
      "branch_condition": "document.querySelector('.error') !== null", // for type=branch
      "branch_true": "step_3",
      "branch_false": "step_2",
      "confidence": 0.9,
      "reasoning": "why this step"
    }
  ],
  "assumptions": ["user is not logged in", "form is visible"],
  "risks": ["captcha may appear", "page may redirect"]
}

Rules:
- Insert wait(network.idle) after form submissions and clicks that trigger navigation
- Insert verify steps after critical actions (login, payment, submission)
- Use branch steps when outcome is uncertain (may or may not need to login)
- Keep confidence honest: 0.9=very sure, 0.7=likely right, 0.5=uncertain
- Return ONLY valid JSON`;

  const text = await callLLM(prompt, { ...config, temperature: 0.1 });
  const raw = parseJSON<{ steps?: PlanStep[]; assumptions?: string[]; risks?: string[] }>(text, { steps: [], assumptions: [], risks: [] });

  return {
    goal,
    steps: (raw.steps ?? []).map((s, i) => ({ ...s, id: s.id ?? `step_${i + 1}` })),
    estimated_steps: raw.steps?.length ?? 0,
    assumptions: raw.assumptions ?? [],
    risks: raw.risks ?? [],
    created_at: new Date().toISOString(),
    provider_used: provider,
  };
}

export function formatPlan(plan: ExecutionPlan): string {
  const lines = [`Plan for: "${plan.goal}" (${plan.steps.length} steps)`];
  for (const step of plan.steps) {
    const conf = step.confidence ? ` [${Math.round(step.confidence * 100)}%]` : "";
    lines.push(`  ${step.id}: ${step.description}${conf}`);
  }
  if (plan.risks.length) lines.push(`Risks: ${plan.risks.join(", ")}`);
  return lines.join("\n");
}
