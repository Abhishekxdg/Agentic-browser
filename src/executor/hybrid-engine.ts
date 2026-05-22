import type { Page } from "playwright";
import type { ApiGraph } from "../graph/types.ts";
import { StealthBrowser, type BrowserConfig } from "../core/browser.ts";
import { DomController, type DomAction } from "../core/dom-controller.ts";
import { VisionController, type VisionConfig } from "../core/vision-controller.ts";
import { AuthHandler, type AuthConfig } from "../auth/auth-handler.ts";
import { CaptchaResolver, type CaptchaConfig } from "../captcha/captcha-resolver.ts";
import { selectStrategy, type ExecutionStrategy } from "../router/strategy-router.ts";
import { executeIntent, type ExecutionResult as ApiExecutionResult } from "./engine.ts";
import type { ExecutionContext } from "./engine.ts";

export interface HybridExecutionResult {
  status: "success" | "error" | "auth_required" | "captcha";
  data?: unknown;
  screenshot?: string; // base64
  steps_executed: number;
  strategy_used: ExecutionStrategy;
  error?: string;
  reasoning?: string;
}

export interface HybridEngineConfig {
  browser?: BrowserConfig;
  vision?: VisionConfig;
  captcha?: CaptchaConfig;
}

export class HybridExecutionEngine {
  private browser: StealthBrowser;
  private domController = new DomController();
  private authHandler = new AuthHandler();
  private captchaResolver?: CaptchaResolver;
  private visionController?: VisionController;

  constructor(config: HybridEngineConfig = {}) {
    this.browser = new StealthBrowser(config.browser);
    if (config.captcha) {
      this.captchaResolver = new CaptchaResolver(config.captcha);
    }
    if (config.vision) {
      this.visionController = new VisionController(config.vision);
    }
  }

  configureAuth(site: string, config: AuthConfig["credentials"], mfaType?: "totp" | "sms" | "none"): void {
    this.authHandler.configure(site, config, mfaType);
  }

  async execute(
    site: string,
    intent: string,
    graph?: ApiGraph,
    orgId = "default",
  ): Promise<HybridExecutionResult> {
    let page: Page;
    let attemptCount = 0;
    let lastError: { strategy: ExecutionStrategy; error: string } | undefined;

    try {
      // Reuse existing browser process, open a fresh page
      page = await this.browser.newPageFresh();
      try {
        await page.goto(site, { waitUntil: "networkidle", timeout: 12000 });
      } catch {
        // Fallback for heavy SPAs (Reddit, Twitter) that never reach networkidle
        await page.goto(site, { waitUntil: "domcontentloaded", timeout: 20000 });
        // Wait a beat for JS to settle
        await page.waitForTimeout(1500);
      }

      // Handle auth if needed
      const authResult = await this.authHandler.authenticate(page, site);
      if (!authResult.success) {
        return {
          status: "auth_required",
          error: authResult.error,
          steps_executed: 0,
          strategy_used: "dom_control",
        };
      }

      // Handle CAPTCHA if present
      if (this.captchaResolver) {
        const captchaResult = await this.captchaResolver.resolve(page);
        if (!captchaResult.solved && captchaResult.error) {
          return {
            status: "captcha",
            error: captchaResult.error,
            steps_executed: 0,
            strategy_used: "dom_control",
          };
        }
      }

      // Strategy loop: try API → DOM → Vision with fallback
      while (attemptCount < 3) {
        const strategy = selectStrategy({
          intent,
          siteUrl: site,
          graph,
          page,
          lastError,
          attemptCount,
        });

        try {
          if (strategy.strategy === "api_replay" && graph && strategy.apiSequence) {
            const result = await this.executeApiReplay(intent, graph, strategy.apiSequence, orgId, authResult);
            if (result.success) {
              return {
                status: "success",
                data: result.steps[result.steps.length - 1]?.response_body,
                steps_executed: result.steps.length,
                strategy_used: "api_replay",
                screenshot: Buffer.from(await this.browser.screenshot()).toString("base64"),
              };
            }
            lastError = { strategy: "api_replay", error: result.error ?? "API replay failed" };
          }

          if (strategy.strategy === "dom_control") {
            const result = await this.executeDomControl(page, intent);
            if (result.success) {
              return {
                status: "success",
                data: result.data,
                steps_executed: result.steps,
                strategy_used: "dom_control",
                screenshot: Buffer.from(await this.browser.screenshot()).toString("base64"),
              };
            }
            lastError = { strategy: "dom_control", error: result.error ?? "DOM control failed" };
          }

          if (strategy.strategy === "vision_ai") {
            if (!this.visionController) {
              return {
                status: "error",
                error: `Vision AI not configured. Previous errors: ${JSON.stringify(lastError)}`,
                steps_executed: attemptCount,
                strategy_used: "vision_ai",
              };
            }
            const result = await this.executeVisionAI(page, intent);
            if (result.success) {
              return {
                status: "success",
                data: result.data,
                steps_executed: result.steps,
                strategy_used: "vision_ai",
                screenshot: Buffer.from(await this.browser.screenshot()).toString("base64"),
                reasoning: result.reasoning,
              };
            }
            lastError = { strategy: "vision_ai", error: result.error ?? "Vision AI failed" };
          }
        } catch (err) {
          lastError = {
            strategy: strategy.strategy,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        attemptCount++;
      }

      return {
        status: "error",
        error: lastError?.error ?? "All strategies exhausted",
        steps_executed: attemptCount,
        strategy_used: lastError?.strategy ?? "vision_ai",
      };
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        steps_executed: attemptCount,
        strategy_used: "dom_control",
      };
    } finally {
      // Only close the page, keep browser alive for next request
      await this.browser.closePage();
    }
  }

  private async executeApiReplay(
    intent: string,
    graph: ApiGraph,
    sequence: import("../graph/types.ts").GraphNode[],
    orgId: string,
    authResult: import("../auth/auth-handler.ts").AuthResult,
  ): Promise<ApiExecutionResult> {
    const ctx: ExecutionContext = {
      org_id: orgId,
      auth_token: authResult.authToken,
      cookies: authResult.cookies,
      base_url: graph.site_host,
      on_auth_required: async () => null,
      on_drift_detected: () => {},
    };

    // Override the intent resolver to return our pre-computed sequence
    const resolveIntent = async (): Promise<typeof sequence> => sequence;

    return await executeIntent(intent, graph, ctx, resolveIntent);
  }

  private async executeDomControl(
    page: Page,
    intent: string,
  ): Promise<{ success: boolean; steps: number; data?: unknown; error?: string }> {
    // Detect relevant elements on the page
    const elements = await this.domController.detectElements(page, intent);

    // Build action sequence from intent and detected elements
    const actions = this.buildActionsFromIntent(intent, elements);

    // If no specific actions needed but page is loaded, extract data and return success
    if (actions.length === 0) {
      const lowerIntent = intent.toLowerCase();
      const isSimpleBrowse = lowerIntent.includes("navigate") ||
        lowerIntent.includes("go to") ||
        lowerIntent.includes("visit") ||
        lowerIntent.includes("open") ||
        lowerIntent.includes("load");

      if (isSimpleBrowse && page.url()) {
        return {
          success: true,
          steps: 1,
          data: await this.extractPageData(page, intent),
        };
      }

      return {
        success: false,
        error: "Could not determine DOM actions for intent",
        steps: 0,
      };
    }

    const results = await this.domController.execute(page, actions);
    const success = results.every((r) => r.success);

    // Brief settle after actions (SPAs may navigate without load events)
    if (success) {
      await page.waitForTimeout(1200);
    }

    // Extract data from page after execution
    let data: unknown = undefined;
    if (success) {
      data = await this.extractPageData(page, intent);
    }

    return {
      success,
      steps: results.length,
      data,
      error: success ? undefined : results.find((r) => !r.success)?.error,
    };
  }

  private async executeVisionAI(
    page: Page,
    intent: string,
  ): Promise<{ success: boolean; steps: number; data?: unknown; error?: string; reasoning?: string }> {
    if (!this.visionController) {
      return { success: false, error: "Vision AI not configured", steps: 0 };
    }

    let previousActions: DomAction[] = [];
    let maxSteps = 10;
    let step = 0;

    while (step < maxSteps) {
      const decision = await this.visionController.decideActions(page, intent, previousActions);
      if (!decision.success) {
        return {
          success: false,
          error: decision.error ?? "Vision AI failed",
          steps: step,
        };
      }

      if (decision.actions.length === 0) {
        // Vision model says task is complete
        const data = await this.extractPageData(page, intent);
        return {
          success: true,
          steps: step,
          data,
          reasoning: decision.reasoning,
        };
      }

      // Execute the actions decided by vision model
      const results = await this.domController.execute(page, decision.actions);
      previousActions.push(...decision.actions);

      const allSuccess = results.every((r) => r.success);
      if (!allSuccess) {
        return {
          success: false,
          error: results.find((r) => !r.success)?.error ?? "DOM action failed",
          steps: step + results.length,
          reasoning: decision.reasoning,
        };
      }

      step += decision.actions.length;
    }

    return {
      success: true,
      steps: step,
      data: await this.extractPageData(page, intent),
      reasoning: `Reached max steps (${maxSteps}). Task may be incomplete.`,
    };
  }

  private buildActionsFromIntent(intent: string, elements: Record<string, string>): DomAction[] {
    const actions: DomAction[] = [];
    const lower = intent.toLowerCase();

    // --- Pattern 1: search/look up/find ---
    // "search for X", "search X", "look up X", "find X"
    const searchMatch = lower.match(/(?:search(?:\s+for)?|look\s+up|find)\s+["']?(.+?)["']?\s*$/i);
    if (searchMatch) {
      const query = searchMatch[1]!.trim();
      const searchField = elements["search"] || elements["searchbox"] || elements["q"] || elements["query"];
      if (searchField) {
        actions.push({ type: "type", target: searchField, value: query });
        if (elements["submit"]) actions.push({ type: "click", target: elements["submit"] });
        else actions.push({ type: "press", target: "Enter", value: searchField }); // submit via Enter
        return actions;
      }
    }

    // --- Pattern 2: fill field with value ---
    // "fill NAME with VALUE", "fill in NAME with VALUE", "enter VALUE in NAME", "type VALUE in NAME"
    const fillPatterns = [
      // "fill the custname field with Test User"  /  "fill custname with Test User"
      /(?:fill(?:\s+in)?|enter|put|type)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:field\s+|input\s+|box\s+)?(?:with|as)\s+["']?(.+?)["']?\s*$/i,
      // "enter Test User in the custname field"  /  "type Test User in custname"
      /(?:enter|type)\s+["']?(.+?)["']?\s+(?:in(?:to)?\s+(?:the\s+)?|for\s+(?:the\s+)?)["']?(.+?)["']?(?:\s+field|\s+input|\s+box)?\s*$/i,
    ];

    for (const pattern of fillPatterns) {
      const m = intent.match(pattern);
      if (m) {
        // Pattern 3 swaps field/value order
        const isReversed = pattern.source.startsWith("(?:enter|type)");
        const fieldHint = (isReversed ? m[2] : m[1])!.toLowerCase().trim();
        const value = (isReversed ? m[1] : m[2])!.trim();

        const selector = this.findBestElement(elements, fieldHint);
        if (selector) {
          actions.push({ type: "type", target: selector, value });
          continue;
        }
      }
    }

    // --- Pattern 3: click something ---
    // "click X", "press X", "tap X"
    const clickMatch = lower.match(/(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?["']?(.+?)["']?\s*$/i);
    if (clickMatch && actions.length === 0) {
      const target = clickMatch[1]!.trim();
      const selector = this.findBestElement(elements, target);
      if (selector) {
        actions.push({ type: "click", target: selector });
        return actions;
      }
    }

    // --- Pattern 4: select/choose ---
    // "select X from Y", "choose X"
    const selectMatch = lower.match(/(?:select|choose)\s+["']?(.+?)["']?\s+(?:from|in)\s+["']?(.+?)["']?\s*$/i);
    if (selectMatch) {
      const value = selectMatch[1]!.trim();
      const fieldHint = selectMatch[2]!.trim();
      const selector = this.findBestElement(elements, fieldHint);
      if (selector) {
        actions.push({ type: "select", target: selector, value });
        return actions;
      }
    }

    // --- Pattern 5: login/signin ---
    if (/\b(log\s*in|sign\s*in)\b/.test(lower)) {
      if (elements["email"]) actions.push({ type: "type", target: elements["email"], value: "{{email}}" });
      if (elements["username"]) actions.push({ type: "type", target: elements["username"], value: "{{username}}" });
      if (elements["password"]) actions.push({ type: "type", target: elements["password"], value: "{{password}}" });
      if (elements["submit"]) actions.push({ type: "click", target: elements["submit"] });
      return actions;
    }

    // --- Pattern 6: submit a form generically ---
    if (actions.length > 0 && elements["submit"]) {
      actions.push({ type: "click", target: elements["submit"] });
    }

    return actions;
  }

  /** Find best selector by scoring element keys against a hint string */
  private findBestElement(elements: Record<string, string>, hint: string): string | undefined {
    const hintWords = hint.split(/\W+/).filter((w) => w.length > 1);
    let best: string | undefined;
    let bestScore = 0;

    for (const [key, selector] of Object.entries(elements)) {
      let score = 0;
      for (const word of hintWords) {
        if (key.includes(word)) score += 10;
        if (new RegExp(`\\b${word}\\b`).test(key)) score += 5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = selector;
      }
    }

    // Fallback: direct key lookup
    if (!best) {
      for (const word of hintWords) {
        if (elements[word]) return elements[word];
      }
    }

    return best;
  }

  private async extractPageData(page: Page, intent: string): Promise<unknown> {
    // Extract structured data based on intent
    const url = page.url();
    const title = await page.title().catch(() => "");

    // Look for tables, lists, or specific data patterns
    const bodyText = await page.locator("body").textContent().catch(() => "");

    return {
      url,
      title,
      text_snippet: bodyText?.slice(0, 1000),
      intent_matched: intent,
    };
  }
}
