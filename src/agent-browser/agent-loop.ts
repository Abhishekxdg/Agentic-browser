/**
 * LLM Agent Loop — real ReAct (Reason + Act) loop.
 * Observe (page model) → LLM thinks → execute action → repeat until done.
 * Works with Gemini, OpenAI, or Anthropic. No Playwright dependency.
 */

import type { BrowserSession } from "./session-manager.ts";
import { refreshPageModel, executeAction } from "./session-manager.ts";
import type { SemanticPage } from "./semantic-page.ts";
import type { SemanticAction } from "./action-resolver.ts";
import { addCorrection, loadMemory } from "../layer2/site-memory.ts";
import { callLLMMessages, detectProvider as detectLLMProvider, parseJSON, type LLMProvider as LLMProviderType, type LLMConfig } from "./llm.ts";

export interface AgentLoopConfig {
  goal: string;
  max_steps?: number;
  provider?: LLMProviderType;
  model?: string;
  api_key?: string;
  site_url?: string; // for site memory lookup
  on_step?: (step: AgentStep) => void; // real-time step callback
}

export interface AgentStep {
  step: number;
  observation: string;   // compressed page summary
  thought: string;       // LLM reasoning
  action: SemanticAction | null;
  result: "success" | "failed" | "done";
  error?: string;
  page_url?: string;
}

export interface AgentRunResult {
  success: boolean;
  goal: string;
  steps: AgentStep[];
  final_answer?: string;
  total_steps: number;
  error?: string;
}

// ── Page model → compact observation string ────────────────────────────────

function compressPage(page: SemanticPage): string {
  const lines: string[] = [];
  lines.push(`URL: ${page.page.url}`);
  lines.push(`TITLE: ${page.page.title}`);

  if (page.forms.length > 0) {
    lines.push(`FORMS:`);
    for (const f of page.forms) {
      const fields = f.fields.map((fi) => `${fi.name}(${fi.type}${fi.value ? `="${fi.value}"` : ""})`).join(", ");
      const btns = f.actions.map((a) => a.label).join(", ");
      lines.push(`  [${f.id}${f.purpose ? ` purpose=${f.purpose}` : ""}] fields:[${fields}] buttons:[${btns}]`);
    }
  }

  if (page.interactive.length > 0) {
    const buttons = page.interactive.slice(0, 12).map((i) => `"${i.label}"(${i.type})`).join(", ");
    lines.push(`INTERACTIVE: ${buttons}`);
  }

  if (page.dialogs.length > 0) {
    for (const d of page.dialogs) {
      lines.push(`DIALOG: ${d.type} "${d.title || d.message || ""}" actions:[${d.actions.join(", ")}]`);
    }
  }

  if (page.content.length > 0) {
    const headings = page.content.filter((c) => c.type === "heading").slice(0, 3).map((c) => c.text).join(" | ");
    if (headings) lines.push(`HEADINGS: ${headings}`);
  }

  if (page.tables.length > 0) {
    const firstTable = page.tables[0];
    if (firstTable) lines.push(`TABLES: ${page.tables.length} (first: ${firstTable.headers.join(", ")})`);
  }

  return lines.join("\n");
}

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(goal: string, siteMemory: ReturnType<typeof loadMemory>): string {
  const corrections = siteMemory.corrections.length > 0
    ? `\nKnown corrections for this site:\n${siteMemory.corrections.map((c) => `- "${c.original_action}" → use "${c.corrected_action}" (${c.reason})`).join("\n")}`
    : "";

  const timings = Object.keys(siteMemory.timing_hints).length > 0
    ? `\nKnown timing hints: ${JSON.stringify(siteMemory.timing_hints)}`
    : "";

  return `You are an autonomous web agent. Your goal: "${goal}"

You observe the current page state (forms, buttons, dialogs, content) and decide what to do next.

RESPONSE FORMAT — always reply with valid JSON matching ONE of these:
1. Next action:  {"thought":"reasoning","action":{"type":"...","...":"..."}}
2. Task done:    {"thought":"reasoning","done":true,"result":"what was accomplished"}
3. Stuck:        {"thought":"reasoning","stuck":true,"reason":"why stuck"}

AVAILABLE ACTION TYPES:
- navigate:        {"type":"navigate","url":"https://..."}
- fill:            {"type":"fill","form":"formId","field":"fieldName","value":"text"}
- fill_selector:   {"type":"fill_selector","selector":"css","value":"text"}
- click:           {"type":"click","target":"visible label"}
- click_text:      {"type":"click_text","text":"exact text"}
- click_selector:  {"type":"click_selector","selector":"css selector"}
- press:           {"type":"press","key":"Enter"}
- wait:            {"type":"wait","condition":"network.idle","ms":2000}
- scroll:          {"type":"scroll","direction":"down"}
- handle_dialog:   {"type":"handle_dialog","accept":true}
- evaluate:        run inline JS: {"type":"evaluate","expression":"js here"}

RULES:
- Use fill/click with semantic names first (preferred)
- Fall back to fill_selector/click_selector if semantic fails
- After every fill+submit, wait for network.idle
- If a dialog appears, handle it before continuing
- If stuck 3 times in a row, respond with stuck:true${corrections}${timings}`;
}

// ── LLM call ───────────────────────────────────────────────────────────────

async function callLLM(
  messages: Array<{ role: string; content: string }>,
  config: AgentLoopConfig,
): Promise<string> {
  return callLLMMessages(messages, {
    provider: config.provider,
    model: config.model,
    api_key: config.api_key,
    temperature: 0.1,
  });
}

function detectProvider(apiKey?: string): LLMProviderType {
  return detectLLMProvider(apiKey);
}

function parseDecision(text: string): { thought: string; action?: SemanticAction; done?: boolean; stuck?: boolean; result?: string; reason?: string } {
  return parseJSON(text, { thought: "failed to parse LLM response", stuck: true, reason: "LLM returned invalid JSON" });
}

// ── Main loop ──────────────────────────────────────────────────────────────

const _failedActions = new Map<number, string>(); // step index → failed action JSON

export async function runAgentLoop(session: BrowserSession, config: AgentLoopConfig): Promise<AgentRunResult> {
  _failedActions.clear();
  const maxSteps = config.max_steps ?? 20;
  const steps: AgentStep[] = [];
  const messages: Array<{ role: string; content: string }> = [];
  let consecutiveStuck = 0;

  const siteHost = config.site_url ? new URL(config.site_url).host : "unknown";
  const siteMemory = loadMemory(siteHost);

  messages.push({ role: "system", content: buildSystemPrompt(config.goal, siteMemory) });

  for (let i = 0; i < maxSteps; i++) {
    // Observe
    const page = await refreshPageModel(session);
    const observation = compressPage(page);

    messages.push({ role: "user", content: `STEP ${i + 1}\n${observation}` });

    // Think
    const rawResponse = await callLLM(messages, config);
    const decision = parseDecision(rawResponse);

    messages.push({ role: "assistant", content: rawResponse });

    const step: AgentStep = {
      step: i + 1,
      observation,
      thought: decision.thought,
      action: decision.action ?? null,
      result: "success",
      page_url: page.page.url,
    };

    // Done
    if (decision.done) {
      step.result = "done";
      steps.push(step);
      config.on_step?.(step);
      return { success: true, goal: config.goal, steps, final_answer: decision.result, total_steps: steps.length };
    }

    // Stuck
    if (decision.stuck) {
      consecutiveStuck++;
      step.result = "failed";
      step.error = decision.reason;
      steps.push(step);
      config.on_step?.(step);
      if (consecutiveStuck >= 3) {
        return { success: false, goal: config.goal, steps, error: `Stuck: ${decision.reason}`, total_steps: steps.length };
      }
      continue;
    }

    consecutiveStuck = 0;

    if (!decision.action) {
      step.result = "failed";
      step.error = "LLM returned no action";
      steps.push(step);
      config.on_step?.(step);
      continue;
    }

    // Handle custom evaluate action
    if ((decision.action as any).type === "evaluate") {
      try {
        const result = await session.cdp.evaluate((decision.action as any).expression);
        step.result = "success";
        messages.push({ role: "user", content: `JS result: ${JSON.stringify(result)}` });
      } catch (e: any) {
        step.result = "failed";
        step.error = e.message;
      }
      steps.push(step);
      config.on_step?.(step);
      continue;
    }

    // Act
    const actionResult = await executeAction(session, decision.action);

    if (actionResult.success) {
      step.result = "success";
    } else {
      step.result = "failed";
      step.error = actionResult.error;

      // Self-healing: tell LLM the action failed
      messages.push({ role: "user", content: `Action FAILED: ${actionResult.error}. Try a different approach.` });

      // Log for future memory if we find a correction later
      if (siteHost !== "unknown") {
        const actionKey = JSON.stringify(decision.action);
        const existing = siteMemory.corrections.find((c) => c.original_action === actionKey);
        if (!existing) {
          // Will be filled if next action succeeds
          _failedActions.set(steps.length, actionKey);
        }
      }
    }

    steps.push(step);
    config.on_step?.(step);

    // Self-learning: if action after a failure succeeded, store the correction
    if (actionResult.success && steps.length >= 2) {
      const prev = steps[steps.length - 2];
      const prevFailedAction = _failedActions.get(steps.length - 2);
    if (actionResult.success && prevFailedAction && siteHost !== "unknown") {
      addCorrection(siteHost, prevFailedAction, JSON.stringify(decision.action), `Previous action failed: ${steps[steps.length - 2]?.error}`);
      _failedActions.delete(steps.length - 2);
    }
    }
  }

  return { success: false, goal: config.goal, steps, error: `Max steps (${maxSteps}) reached`, total_steps: steps.length };
}
