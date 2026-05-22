/**
 * Vision-Semantic Fusion — hybrid DOM + screenshot pipeline.
 * Semantic extraction is primary; vision fills gaps for canvas, WebGL, shadow DOM.
 * Not screenshot-only (slow + expensive) but a true DOM + vision hybrid.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { SemanticPage } from "./semantic-page.ts";
import type { VisionConfig } from "./multimodal-perception.ts";
import { queryVisualElements, findElementByDescription, type GroundedElement } from "./visual-grounding.ts";

export type FusionMode = "dom-primary" | "vision-primary" | "balanced";

export interface FusionResult {
  /** The merged page model with visual annotations */
  page: SemanticPage;
  /** Visual elements that have no DOM counterpart */
  visionOnly: GroundedElement[];
  /** DOM elements that were visually confirmed present */
  visuallyConfirmed: string[]; // selectors
  /** Which mode was used */
  mode: FusionMode;
  /** Whether the page appears to be canvas/WebGL dominated */
  canvasDominant: boolean;
}

export interface FusionConfig {
  vision: VisionConfig;
  /** Threshold: if DOM interactive count < this, switch to vision-primary */
  domElementThreshold?: number;
  /** Always run vision segmentation (slower but more complete) */
  alwaysSegment?: boolean;
}

// ── Canvas / WebGL Detection ───────────────────────────────────────────────

async function isCanvasDominant(cdp: CDPBridge): Promise<boolean> {
  const result = await cdp.evaluate(`(function() {
    const canvas = document.querySelectorAll("canvas").length;
    const interactive = document.querySelectorAll(
      "button, a, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])"
    ).length;
    const video = document.querySelectorAll("video").length;
    const bodyText = document.body?.innerText?.length ?? 0;
    return {
      canvasDominant: canvas > 0 && interactive < 5,
      webgl: !!document.querySelector("canvas") && (
        !!document.querySelector("canvas").getContext("webgl") ||
        !!document.querySelector("canvas").getContext("webgl2")
      ),
      stream: video > 0 && interactive < 3,
      minimalDom: interactive < 3 && bodyText < 200,
    };
  })()`);
  const r = result as Record<string, boolean | undefined>;
  return (r.canvasDominant ?? false) || (r.webgl ?? false) || (r.stream ?? false) || (r.minimalDom ?? false);
}

// ── DOM + Vision Merge ─────────────────────────────────────────────────────

export async function fusePageModel(
  cdp: CDPBridge,
  semanticPage: SemanticPage,
  config: FusionConfig,
): Promise<FusionResult> {
  const canvasDominant = await isCanvasDominant(cdp);
  const mode: FusionMode = canvasDominant
    ? "vision-primary"
    : (config.alwaysSegment ? "balanced" : "dom-primary");

  // Fast path: DOM-only if there are plenty of interactive elements and no canvas
  if (mode === "dom-primary" && !config.alwaysSegment) {
    return {
      page: semanticPage,
      visionOnly: [],
      visuallyConfirmed: [],
      mode,
      canvasDominant,
    };
  }

  // Run visual segmentation
  const visual = await queryVisualElements(cdp, config.vision);
  if (!visual.success) {
    // Vision failed, fall back to DOM
    return {
      page: semanticPage,
      visionOnly: [],
      visuallyConfirmed: [],
      mode: "dom-primary",
      canvasDominant,
    };
  }

  const visionOnly: GroundedElement[] = [];
  const visuallyConfirmed: string[] = [];

  for (const ve of visual.elements) {
    if (ve.domSelector) {
      visuallyConfirmed.push(ve.domSelector);
    } else {
      // This visual element has no DOM match — add to vision-only
      visionOnly.push(ve);
    }
  }

  // Enrich semantic page with vision annotations
  const enrichedPage = enrichWithVisual(semanticPage, visual.elements);

  return {
    page: enrichedPage,
    visionOnly,
    visuallyConfirmed,
    mode,
    canvasDominant,
  };
}

// ── Enrich Semantic Page with Visual Data ──────────────────────────────────

function enrichWithVisual(page: SemanticPage, visualElements: GroundedElement[]): SemanticPage {
  // Add visual-only interactive elements as "virtual" interactive items
  const virtualInteractive = visualElements
    .filter((ve) => ve.visualType === "button" || ve.visualType === "input")
    .map((ve) => ({
      id: `vision-${ve.description.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 30)}`,
      type: ve.visualType === "button" ? "button" : "input",
      label: ve.description,
      purpose: ve.description,
      bbox: ve.bbox,
      source: "vision" as const,
    }));

  // Deep clone-ish merge
  return {
    ...page,
    interactive: [...page.interactive, ...virtualInteractive.map((v) => ({
      id: v.id,
      type: v.type,
      label: v.label,
      purpose: v.purpose,
      tag: v.type,
    }))],
    // Add a visual metadata section
    _visual: {
      elements: visualElements,
      timestamp: new Date().toISOString(),
    },
  } as SemanticPage;
}

// ── Fallback Action Resolution with Vision ───────────────────────────────────

/**
 * When DOM-based action resolution fails, try vision-based resolution.
 * Returns a coordinate-based SemanticAction if vision succeeds.
 */
export async function resolveWithVision(
  cdp: CDPBridge,
  config: FusionConfig,
  actionType: "click" | "fill" | "hover",
  targetDescription: string,
): Promise<{ action: { type: "click_coords"; x: number; y: number }; confidence: number } | null> {
  const element = await findElementByDescription(cdp, config.vision, targetDescription);
  if (!element) return null;

  const vp = await cdp.evaluate(`(function() {
    return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  })()`) as { w: number; h: number; dpr: number };

  const cx = Math.round((element.bbox.x + element.bbox.w / 2) * vp.w);
  const cy = Math.round((element.bbox.y + element.bbox.h / 2) * vp.h);

  return {
    action: { type: "click_coords", x: cx, y: cy },
    confidence: element.confidence,
  };
}

// ── Canvas Action Execution ────────────────────────────────────────────────

/**
 * Execute actions on canvas/WebGL apps where DOM is unavailable.
 * Uses visual grounding for coordinate-based interactions.
 */
export async function executeCanvasAction(
  cdp: CDPBridge,
  config: FusionConfig,
  intent: string,
): Promise<{ success: boolean; actionsTaken: string[]; error?: string }> {
  const { decideVisualActions, visionToSemantic } = await import("./multimodal-perception.ts");
  const result = await decideVisualActions(cdp, config.vision, intent);

  if (!result.success) {
    return { success: false, actionsTaken: [], error: result.error };
  }

  const actionsTaken: string[] = [];

  for (const va of result.actions) {
    const semantic = visionToSemantic(va);
    if (semantic.type === "click_coords" && va.x !== undefined && va.y !== undefined) {
      const vp = await cdp.evaluate(`(function() {
        return { w: window.innerWidth, h: window.innerHeight };
      })()`) as { w: number; h: number };
      const x = Math.round(va.x * vp.w);
      const y = Math.round(va.y * vp.h);
      await cdp.clickAt(x, y);
      actionsTaken.push(`click at (${x}, ${y}) — ${va.target ?? ""}`);
    } else if (semantic.type === "type_text" && va.value) {
      await cdp.typeText(va.value);
      actionsTaken.push(`type "${va.value}"`);
    } else if (semantic.type === "wait") {
      await new Promise((r) => setTimeout(r, va.value ? Number(va.value) : 2000));
      actionsTaken.push("wait");
    }
  }

  return { success: true, actionsTaken };
}
