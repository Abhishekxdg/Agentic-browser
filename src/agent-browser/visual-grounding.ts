/**
 * Visual Grounding — map semantic descriptions to screen coordinates.
 * "top-right blue button" → {x: 0.85, y: 0.05} + bounding box.
 * Bridges natural language spatial references with actual screen pixels.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { VisionConfig, MultimodalResult } from "./multimodal-perception.ts";
import { decideVisualActions } from "./multimodal-perception.ts";

export interface BoundingBox {
  x: number; // normalized 0-1
  y: number;
  w: number;
  h: number;
}

export interface GroundedElement {
  description: string;
  bbox: BoundingBox;
  confidence: number;
  /** If this element overlaps with a known DOM element, its selector */
  domSelector?: string;
  /** Element type guessed from visual appearance */
  visualType: "button" | "input" | "text" | "image" | "icon" | "unknown";
}

export interface GroundingResult {
  success: boolean;
  elements: GroundedElement[];
  error?: string;
  screenshotBase64?: string;
}

export interface CoordinateMapping {
  /** Viewport width in pixels */
  viewportWidth: number;
  /** Viewport height in pixels */
  viewportHeight: number;
  /** Device pixel ratio */
  dpr: number;
}

// ── Viewport Geometry ──────────────────────────────────────────────────────

async function getViewportInfo(cdp: CDPBridge): Promise<CoordinateMapping> {
  const result = await cdp.evaluate(`(function() {
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  })()`);
  return result as CoordinateMapping;
}

function normToPixel(norm: number, size: number): number {
  return Math.round(norm * size);
}

function pixelToNorm(px: number, size: number): number {
  return Math.max(0, Math.min(1, px / size));
}

// ── Element Segmentation via Vision Model ─────────────────────────────────

async function segmentElements(
  cdp: CDPBridge,
  config: VisionConfig,
): Promise<GroundedElement[]> {
  const screenshot = await cdp.screenshot(false);
  const prompt = `Analyze this web page screenshot. Identify all interactive and notable UI elements.

For each element, return an object with:
- description: brief visual description (e.g. "blue Submit button", "search input field")
- bbox: bounding box as normalized coordinates {x, y, w, h} where x,y is top-left and values are 0.0 to 1.0
- visualType: one of "button", "input", "text", "image", "icon", "unknown"

Return a JSON array ONLY. Example:
[
  {"description":"blue Submit button","bbox":{"x":0.72,"y":0.42,"w":0.12,"h":0.05},"visualType":"button"},
  {"description":"email input field","bbox":{"x":0.15,"y":0.35,"w":0.40,"h":0.05},"visualType":"input"}
]`;

  let content: string;
  switch (config.provider ?? "openai") {
    case "anthropic":
      content = JSON.stringify(await callAnthropicVision(config, screenshot, prompt));
      break;
    case "gemini":
      content = JSON.stringify(await callGeminiVision(config, screenshot, prompt));
      break;
    default:
      content = JSON.stringify(await callOpenAIVision(config, screenshot, prompt));
  }

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const raw = JSON.parse(jsonMatch[0]) as Array<{
      description: string;
      bbox: { x: number; y: number; w: number; h: number };
      visualType?: string;
      confidence?: number;
    }>;

    return raw.map((r) => ({
      description: r.description,
      bbox: { x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h },
      confidence: r.confidence ?? 0.8,
      visualType: (r.visualType ?? "unknown") as GroundedElement["visualType"],
    }));
  } catch {
    return [];
  }
}

async function callOpenAIVision(config: VisionConfig, base64: string, prompt: string): Promise<unknown[]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model ?? "gpt-4o",
      max_tokens: config.maxTokens ?? 2048,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }] }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI: ${res.status}`);
  const data = await res.json();
  return parseVisionResponse(data.choices?.[0]?.message?.content as string);
}

async function callAnthropicVision(config: VisionConfig, base64: string, prompt: string): Promise<unknown[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model ?? "claude-3-5-sonnet-20241022",
      max_tokens: config.maxTokens ?? 2048,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }] }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic: ${res.status}`);
  const data = await res.json();
  return parseVisionResponse(data.content?.[0]?.text as string);
}

async function callGeminiVision(config: VisionConfig, base64: string, prompt: string): Promise<unknown[]> {
  const model = config.model ?? "gemini-2.0-flash-exp";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: base64 } }] }],
      generationConfig: { maxOutputTokens: config.maxTokens ?? 2048 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini: ${res.status}`);
  const data = await res.json();
  return parseVisionResponse(data.candidates?.[0]?.content?.parts?.[0]?.text as string);
}

function parseVisionResponse(content: string): unknown[] {
  if (!content) return [];
  const m = content.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}

// ── DOM-to-Visual Alignment ────────────────────────────────────────────────

/** Try to match a visual bounding box to a DOM element by evaluating coordinate overlap */
async function alignToDOM(
  cdp: CDPBridge,
  bbox: BoundingBox,
): Promise<string | undefined> {
  const vp = await getViewportInfo(cdp);
  const cx = normToPixel(bbox.x + bbox.w / 2, vp.viewportWidth);
  const cy = normToPixel(bbox.y + bbox.h / 2, vp.viewportHeight);

  const result = await cdp.evaluate(`(function() {
    const el = document.elementFromPoint(${cx}, ${cy});
    if (!el) return null;
    // Build a specific selector
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.split(/\s+/).filter(Boolean).join('.')
      : '';
    const attrs = [];
    if (el.getAttribute('aria-label')) attrs.push('[aria-label="' + el.getAttribute('aria-label') + '"]');
    if (el.getAttribute('name')) attrs.push('[name="' + el.getAttribute('name') + '"]');
    if (el.getAttribute('data-testid')) attrs.push('[data-testid="' + el.getAttribute('data-testid') + '"]');
    return {
      selector: tag + id + cls + attrs.join(''),
      text: (el.textContent || '').trim().slice(0, 50),
    };
  })()`);

  if (result && (result as any).selector) {
    return (result as any).selector as string;
  }
  return undefined;
}

// ── Semantic Query ─────────────────────────────────────────────────────────

export async function queryVisualElements(
  cdp: CDPBridge,
  config: VisionConfig,
  query?: string, // e.g. "all buttons", "input fields", "the blue submit button"
): Promise<GroundingResult> {
  try {
    const screenshot = await cdp.screenshot(false);
    const elements = await segmentElements(cdp, config);

    // If query provided, filter by relevance (simple keyword match for now)
    let filtered = elements;
    if (query) {
      const q = query.toLowerCase();
      filtered = elements.filter((e) => e.description.toLowerCase().includes(q));
    }

    // Align each to DOM if possible
    const aligned = await Promise.all(
      filtered.map(async (el) => {
        const domSelector = await alignToDOM(cdp, el.bbox).catch(() => undefined);
        return { ...el, domSelector };
      }),
    );

    return { success: true, elements: aligned, screenshotBase64: screenshot };
  } catch (err) {
    return {
      success: false,
      elements: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Find a single element by natural language description */
export async function findElementByDescription(
  cdp: CDPBridge,
  config: VisionConfig,
  description: string,
): Promise<GroundedElement | null> {
  const result = await queryVisualElements(cdp, config, description);
  if (!result.success || result.elements.length === 0) return null;

  // Sort by confidence, prefer elements whose description best matches
  const q = description.toLowerCase();
  const scored = result.elements.map((el) => {
    const descWords = q.split(/\s+/);
    const matchCount = descWords.filter((w) => el.description.toLowerCase().includes(w)).length;
    const score = matchCount / descWords.length + el.confidence;
    return { ...el, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]!;
}

/** Convert normalized coordinates to CDP click coordinates */
export function normalizedToCDPCoords(bbox: BoundingBox, vp: CoordinateMapping): { x: number; y: number } {
  return {
    x: normToPixel(bbox.x + bbox.w / 2, vp.viewportWidth),
    y: normToPixel(bbox.y + bbox.h / 2, vp.viewportHeight),
  };
}
