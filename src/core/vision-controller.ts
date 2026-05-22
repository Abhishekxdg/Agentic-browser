import type { Page } from "playwright";
import type { DomAction } from "./dom-controller.ts";

export interface VisionConfig {
  apiKey: string;
  model?: string; // e.g. "gpt-4o", "claude-3-opus"
  provider?: "openai" | "anthropic";
  maxTokens?: number;
}

export interface VisionResult {
  success: boolean;
  actions: DomAction[];
  reasoning?: string;
  error?: string;
}

/**
 * Uses a vision model (GPT-4V / Claude) to analyze screenshots and decide actions.
 * This is the final fallback when API replay and DOM control both fail.
 */
export class VisionController {
  private config: VisionConfig;

  constructor(config: VisionConfig) {
    this.config = {
      model: "gpt-4o",
      provider: "openai",
      maxTokens: 2048,
      ...config,
    };
  }

  /**
   * Takes a screenshot of the page, sends it to vision model with the intent,
   * and returns a sequence of DOM actions to execute.
   */
  async decideActions(page: Page, intent: string, previousActions?: DomAction[]): Promise<VisionResult> {
    try {
      const screenshot = await page.screenshot({ fullPage: false, type: "png" });
      const base64 = screenshot.toString("base64");

      const prompt = this.buildPrompt(intent, previousActions);

      const actions = await this.callVisionModel(base64, prompt);

      return {
        success: true,
        actions,
        reasoning: `Vision model decided ${actions.length} actions for intent: "${intent}"`,
      };
    } catch (err) {
      return {
        success: false,
        actions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildPrompt(intent: string, previousActions?: DomAction[]): string {
    let prompt = `You are controlling a web browser. Given the current screenshot and the user's intent, decide the next action(s) to take.

User Intent: "${intent}"

Respond with a JSON array of actions. Each action has:
- type: "click" | "type" | "select" | "scroll" | "wait" | "navigate"
- target: CSS selector or URL (for navigate)
- value: text to type or option to select (only for type/select)
- timeout: milliseconds to wait (only for wait)

Examples:
[
  { "type": "click", "target": "button[type='submit']" },
  { "type": "type", "target": "input[name='email']", "value": "user@example.com" },
  { "type": "wait", "timeout": 2000 }
]

Rules:
- Use the most specific CSS selectors possible (id, name, or data-testid preferred)
- If a form needs to be filled, break it into separate type actions
- Wait after navigation or form submission
- If the task is complete, return an empty array []
- If you're unsure, ask for clarification by returning [{ "type": "wait", "timeout": 5000 }]
`;

    if (previousActions && previousActions.length > 0) {
      prompt += `\nPrevious actions taken:\n${JSON.stringify(previousActions, null, 2)}\n`;
    }

    prompt += `\nReturn ONLY the JSON array, no other text.`;

    return prompt;
  }

  private async callVisionModel(base64Image: string, prompt: string): Promise<DomAction[]> {
    if (this.config.provider === "openai") {
      return await this.callOpenAI(base64Image, prompt);
    }
    if (this.config.provider === "anthropic") {
      return await this.callAnthropic(base64Image, prompt);
    }
    throw new Error(`Unsupported vision provider: ${this.config.provider}`);
  }

  private async callOpenAI(base64Image: string, prompt: string): Promise<DomAction[]> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                },
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

    return this.parseActions(content);
  }

  private async callAnthropic(base64Image: string, prompt: string): Promise<DomAction[]> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
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

    return this.parseActions(content);
  }

  private parseActions(content: string): DomAction[] {
    if (!content) return [];

    // Extract JSON from response (in case there's markdown wrapping)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Try parsing the whole response as JSON
      try {
        return JSON.parse(content) as DomAction[];
      } catch {
        return [];
      }
    }

    try {
      return JSON.parse(jsonMatch[0]) as DomAction[];
    } catch {
      return [];
    }
  }
}
