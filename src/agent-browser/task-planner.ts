/**
 * Task Planner — breaks a high-level goal into checkpointed subtasks.
 * "Book a flight to Tokyo" → [{navigate airline}, {search flights}, {select}, {fill passenger}, {pay}]
 * Each subtask has: expected outcome, rollback action, max retries.
 */

import type { BrowserSession } from "./session-manager.ts";
import { refreshPageModel, executeAction } from "./session-manager.ts";
import { runAgentLoop, type AgentLoopConfig, type AgentStep } from "./agent-loop.ts";
import { waitForHuman } from "./job-queue.ts";
import type { SemanticPage } from "./semantic-page.ts";

export interface SubTask {
  id: string;
  description: string;
  expected_outcome: string;
  max_retries?: number;
  requires_human?: boolean; // HITL flag
  actions_hint?: string[]; // optional hints for the agent loop
}

export interface PlannerConfig {
  goal: string;
  max_subtasks?: number;
  provider?: "gemini" | "openai" | "anthropic";
  model?: string;
  api_key?: string;
  job_id?: string; // for HITL
  on_subtask?: (subtask: SubTask, status: "start" | "done" | "failed" | "retrying") => void;
}

export interface PlannerResult {
  success: boolean;
  goal: string;
  plan: SubTask[];
  completed: number;
  total: number;
  steps: AgentStep[];
  error?: string;
}

// ── Plan generation ────────────────────────────────────────────────────────

async function generatePlan(goal: string, page: SemanticPage, config: PlannerConfig): Promise<SubTask[]> {
  const provider = config.provider ?? detectProvider(config.api_key);
  const pageContext = `Current page: ${page.page.url} — "${page.page.title}"`;

  const prompt = `You are a task decomposition expert. Break down this goal into 3-8 concrete subtasks.

Goal: "${goal}"
${pageContext}

Return a JSON array of subtasks. Each subtask:
{
  "id": "step_1",
  "description": "what to do (concise, action-oriented)",
  "expected_outcome": "what the page/state should look like after this step",
  "max_retries": 2,
  "requires_human": false
}

Set requires_human: true for steps that need payment, 2FA codes, or other sensitive inputs.
Return ONLY the JSON array. No explanation.`;

  let text = "";
  if (provider === "gemini") {
    const key = config.api_key ?? process.env.GEMINI_API_KEY!;
    const model = config.model ?? "gemini-2.5-flash";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generation_config: { temperature: 0.0 } }),
    });
    const data = await res.json() as any;
    text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  } else if (provider === "openai") {
    const key = config.api_key ?? process.env.OPENAI_API_KEY!;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: config.model ?? "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as any;
    text = data.choices?.[0]?.message?.content ?? "[]";
  } else if (provider === "anthropic") {
    const key = config.api_key ?? process.env.ANTHROPIC_API_KEY!;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: config.model ?? "claude-haiku-4-5-20251001", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as any;
    text = data.content?.[0]?.text ?? "[]";
  }

  try {
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch { return []; }
}

function detectProvider(apiKey?: string): "gemini" | "openai" | "anthropic" {
  if (apiKey || process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  throw new Error("No LLM API key found.");
}

// ── Outcome verification ───────────────────────────────────────────────────

async function verifyOutcome(
  session: BrowserSession,
  expectedOutcome: string,
  config: PlannerConfig,
): Promise<boolean> {
  const page = await refreshPageModel(session);
  const provider = config.provider ?? detectProvider(config.api_key);

  const prompt = `Did this subtask complete successfully?

Expected outcome: "${expectedOutcome}"
Current page: ${page.page.url} — "${page.page.title}"
Forms: ${JSON.stringify(page.forms.map((f) => ({ id: f.id, purpose: f.purpose })))}
Interactive: ${JSON.stringify(page.interactive.slice(0, 8).map((i) => i.label))}
Dialogs: ${JSON.stringify(page.dialogs)}

Reply with ONLY: {"success": true} or {"success": false, "reason": "..."}`;

  let text = "";
  if (provider === "gemini") {
    const key = config.api_key ?? process.env.GEMINI_API_KEY!;
    const model = config.model ?? "gemini-2.5-flash";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generation_config: { temperature: 0.0 } }),
    });
    const data = await res.json() as any;
    text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"success":false}';
  } else if (provider === "openai") {
    const key = config.api_key ?? process.env.OPENAI_API_KEY!;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: config.model ?? "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json() as any;
    text = data.choices?.[0]?.message?.content ?? '{"success":false}';
  }

  try {
    const match = text.match(/\{[\s\S]*\}/);
    const result = match ? JSON.parse(match[0]) : { success: false };
    return result.success === true;
  } catch { return false; }
}

// ── Main planner ───────────────────────────────────────────────────────────

export async function runPlanner(session: BrowserSession, config: PlannerConfig): Promise<PlannerResult> {
  const allSteps: AgentStep[] = [];

  // Get initial page context for plan generation
  const initialPage = await refreshPageModel(session);
  const plan = await generatePlan(config.goal, initialPage, config);

  if (plan.length === 0) {
    // Fallback: run as single agent loop
    const result = await runAgentLoop(session, { ...config, max_steps: config.max_subtasks ?? 20 });
    return { success: result.success, goal: config.goal, plan: [], completed: result.total_steps, total: 1, steps: result.steps, error: result.error };
  }

  let completed = 0;

  for (const subtask of plan) {
    config.on_subtask?.(subtask, "start");

    // HITL: human-required steps
    if (subtask.requires_human && config.job_id) {
      const resolution = await waitForHuman(
        config.job_id,
        subtask.description,
        { subtask_id: subtask.id, expected_outcome: subtask.expected_outcome },
      );
      if (!resolution) {
        return { success: false, goal: config.goal, plan, completed, total: plan.length, steps: allSteps, error: `HITL timeout on: ${subtask.description}` };
      }
      // Human resolved — continue to verification
      const verified = await verifyOutcome(session, subtask.expected_outcome, config);
      if (verified) {
        completed++;
        config.on_subtask?.(subtask, "done");
        continue;
      }
    }

    // Run agent loop for this subtask
    const maxRetries = subtask.max_retries ?? 2;
    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) config.on_subtask?.(subtask, "retrying");

      const loopResult = await runAgentLoop(session, {
        goal: subtask.description,
        max_steps: 10,
        provider: config.provider,
        model: config.model,
        api_key: config.api_key,
        site_url: session.pageModel?.page.url,
      });

      allSteps.push(...loopResult.steps);

      if (loopResult.success) {
        // Verify the expected outcome
        const verified = await verifyOutcome(session, subtask.expected_outcome, config);
        if (verified) {
          succeeded = true;
          break;
        }
      }

      if (!loopResult.success && attempt === maxRetries) {
        // Offer HITL if job_id available
        if (config.job_id) {
          const resolution = await waitForHuman(
            config.job_id,
            `Stuck on: ${subtask.description}. Error: ${loopResult.error}`,
            { subtask, page_url: session.pageModel?.page.url },
            5 * 60 * 1000, // 5 min timeout for stuck HITL
          );
          if (resolution) {
            succeeded = await verifyOutcome(session, subtask.expected_outcome, config);
          }
        }
        break;
      }
    }

    if (succeeded) {
      completed++;
      config.on_subtask?.(subtask, "done");
    } else {
      config.on_subtask?.(subtask, "failed");
      return {
        success: false, goal: config.goal, plan, completed, total: plan.length, steps: allSteps,
        error: `Failed on subtask: ${subtask.description}`,
      };
    }
  }

  return { success: completed === plan.length, goal: config.goal, plan, completed, total: plan.length, steps: allSteps };
}
