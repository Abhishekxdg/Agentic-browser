/**
 * Multimodal Perception — vision fallback for DOM-only failures.
 * Handles: canvas apps, WebGL UIs, streamed content, OCR on images.
 * Uses LLM vision APIs (OpenAI, Anthropic, Gemini) via CDP screenshots.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { SemanticAction } from "./action-resolver.ts";

export interface VisionConfig {
  apiKey: string;
  provider?: "openai" | "anthropic" | "gemini";
  model?: string;
  maxTokens?: number;
}

export interface VisionAction {
  type: "click" | "type" | "scroll" | "wait" | "navigate" | "screenshot";
  /** Visual description of target, e.g. "blue submit button in top-right" */
  target?: string;
  /** CSS selector fallback if vision model provides one */
  selector?: string;
  /** Normalized screen coordinates 0-1 (preferred over pixels for viewport independence) */
  x?: number;
  y?: number;
  value?: string;
  reasoning?: string;
}

export interface MultimodalResult {
  success: boolean;
  actions: VisionAction[];
  reasoning?: string;
  error?: string;
  /** Detected UI type: "dom", "canvas", "webgl", "stream", "image" */
  uiType?: string;
}

export interface OCRResult {
  success: boolean;
  textBlocks: Array<{
    text: string;
    confidence: number;
    /** Normalized bounding box */
    bbox: { x: number; y: number; w: number; h: number };
  }>;
  error?: string;
}

// ── UI Type Detection ──────────────────────────────────────────────────────

async function detectUIType(cdp: CDPBridge): Promise<string> {
  const result = await cdp.evaluate(`(function() {
    const canvas = document.querySelectorAll("canvas").length;
    const firstCanvas = document.querySelector("canvas");
    const webgl = canvas > 0 && firstCanvas && (
      !!firstCanvas.getContext("webgl") ||
      !!firstCanvas.getContext("webgl2") ||
      !!firstCanvas.getContext("experimental-webgl")
    );
    const video = document.querySelectorAll("video").length;
    const svg = document.querySelectorAll("svg").length;
    const shadowRoots = [...document.querySelectorAll("*")].filter(e => e.shadowRoot).length;
    const totalInteractive = document.querySelectorAll("button, a, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])").length;
    const bodyText = document.body?.innerText?.length ?? 0;
    return { canvas, webgl: !!webgl, video, svg, shadowRoots, totalInteractive, bodyText };
  })()`);

  const r = result as { canvas?: number; webgl?: boolean; video?: number; svg?: number; shadowRoots?: number; totalInteractive?: number; bodyText?: number };
  if (r.webgl) return "webgl";
  if ((r.canvas ?? 0) > 2 && (r.totalInteractive ?? 0) < 10) return "canvas";
  if ((r.video ?? 0) > 0 && (r.totalInteractive ?? 0) < 5) return "stream";
  if ((r.shadowRoots ?? 0) > 5) return "shadow-dom";
  if ((r.totalInteractive ?? 999) < 3 && (r.bodyText ?? 999) < 100) return "minimal-dom";
  return "dom";
}

// ── Prompt Builder ─────────────────────────────────────────────────────────

function buildVisionPrompt(intent: string, uiType: string, previousActions?: VisionAction[]): string {
  let prompt = `You are controlling a web browser via screenshots. Given the current page screenshot and the user's intent, decide the next action(s).

User Intent: "${intent}"

Detected UI type: ${uiType}

Respond with a JSON array of actions. Each action has:
- type: "click" | "type" | "scroll" | "wait" | "navigate"
- target: visual description of the element (e.g. "blue submit button in top-right corner", "email input field below the logo")
- x, y: optional normalized coordinates (0.0 to 1.0) if you can pinpoint the location
- selector: optional CSS selector if one is clearly visible
- value: text to type (only for type)

Example:
[
  { "type": "click", "target": "blue 'Sign in' button in the top-right corner", "x": 0.85, "y": 0.05 },
  { "type": "type", "target": "email input field", "value": "user@example.com" },
  { "type": "wait", "target": "page to load" }
]

Rules:
- For canvas/WebGL apps, rely on visual position (x, y) since there is no DOM
- For streamed video content, describe the region to interact with
- If the task is complete, return []
- Be specific with visual descriptions (color, position, text label)
- If unsure, return [{ "type": "wait", "target": "for clarification" }]
`;

  if (previousActions && previousActions.length > 0) {
    prompt += `\nPrevious actions:\n${JSON.stringify(previousActions, null, 2)}\n`;
  }

  prompt += "\nReturn ONLY the JSON array, no other text.";
  return prompt;
}

// ── LLM Vision API Calls ───────────────────────────────────────────────────

async function callOpenAI(
  config: VisionConfig,
  base64Image: string,
  prompt: string,
): Promise<VisionAction[]> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? "gpt-4o",
      max_tokens: config.maxTokens ?? 2048,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content as string;
  return parseVisionActions(content);
}

async function callAnthropic(
  config: VisionConfig,
  base64Image: string,
  prompt: string,
): Promise<VisionAction[]> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model ?? "claude-3-5-sonnet-20241022",
      max_tokens: config.maxTokens ?? 2048,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: base64Image,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text as string;
  return parseVisionActions(content);
}

async function callGemini(
  config: VisionConfig,
  base64Image: string,
  prompt: string,
): Promise<VisionAction[]> {
  const model = config.model ?? "gemini-2.0-flash-exp";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: base64Image,
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: config.maxTokens ?? 2048 },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text as string;
  return parseVisionActions(content);
}

function parseVisionActions(content: string): VisionAction[] {
  if (!content) return [];
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  const raw = jsonMatch ? jsonMatch[0] : content;
  try {
    return JSON.parse(raw) as VisionAction[];
  } catch {
    return [];
  }
}

// ── Main Entry: Decide actions from screenshot ─────────────────────────────

export async function decideVisualActions(
  cdp: CDPBridge,
  config: VisionConfig,
  intent: string,
  previousActions?: VisionAction[],
): Promise<MultimodalResult> {
  try {
    const uiType = await detectUIType(cdp);
    const screenshot = await cdp.screenshot(false);
    const prompt = buildVisionPrompt(intent, uiType, previousActions);

    let actions: VisionAction[];
    switch (config.provider ?? "openai") {
      case "anthropic":
        actions = await callAnthropic(config, screenshot, prompt);
        break;
      case "gemini":
        actions = await callGemini(config, screenshot, prompt);
        break;
      default:
        actions = await callOpenAI(config, screenshot, prompt);
    }

    return {
      success: true,
      actions,
      uiType,
      reasoning: `Vision model (${config.provider ?? "openai"}) returned ${actions.length} actions for ${uiType} UI`,
    };
  } catch (err) {
    return {
      success: false,
      actions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── OCR: Extract text from screenshot regions ──────────────────────────────

export async function extractTextFromRegion(
  cdp: CDPBridge,
  config: VisionConfig,
  region?: { x: number; y: number; w: number; h: number },
): Promise<OCRResult> {
  try {
    const screenshot = await cdp.screenshot(false);
    const prompt = region
      ? `Read all text visible in this screenshot region (roughly ${Math.round(region.x * 100)}%,${Math.round(region.y * 100)}% to ${Math.round((region.x + region.w) * 100)}%,${Math.round((region.y + region.h) * 100)}%). Return JSON: {"textBlocks":[{"text":"...","confidence":0.95,"bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.1}}]}`
      : `Read all text visible in this screenshot. Return JSON: {"textBlocks":[{"text":"...","confidence":0.95,"bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.1}}]}`;

    let content: string;
    switch (config.provider ?? "openai") {
      case "anthropic": {
        const data = await callAnthropic(config, screenshot, prompt + "\nReturn ONLY the JSON object.");
        content = JSON.stringify(data);
        break;
      }
      case "gemini": {
        const data = await callGemini(config, screenshot, prompt + "\nReturn ONLY the JSON object.");
        content = JSON.stringify(data);
        break;
      }
      default: {
        const data = await callOpenAI(config, screenshot, prompt + "\nReturn ONLY the JSON object.");
        content = JSON.stringify(data);
        break;
      }
    }

    // The vision model should return the OCR JSON directly
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as OCRResult;
      return { success: true, textBlocks: parsed.textBlocks ?? [] };
    }

    return { success: false, textBlocks: [], error: "Could not parse OCR response" };
  } catch (err) {
    return {
      success: false,
      textBlocks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Convert VisionAction to SemanticAction ─────────────────────────────────

export function visionToSemantic(action: VisionAction): SemanticAction {
  switch (action.type) {
    case "click":
      if (action.x !== undefined && action.y !== undefined) {
        return { type: "click_coords", x: action.x, y: action.y };
      }
      if (action.selector) {
        return { type: "click_selector", selector: action.selector };
      }
      return { type: "click", target: action.target ?? "unknown" };
    case "type":
      if (action.selector) {
        return { type: "fill_selector", selector: action.selector, value: action.value ?? "" };
      }
      return { type: "type_text", text: action.value ?? "" };
    case "scroll":
      return { type: "scroll", direction: "down" };
    case "wait":
      return { type: "wait", condition: "time", ms: 2000 };
    case "navigate":
      return { type: "navigate", url: action.value ?? "" };
    case "screenshot":
      return { type: "screenshot" };
    default:
      return { type: "wait", condition: "time", ms: 1000 };
  }
}
