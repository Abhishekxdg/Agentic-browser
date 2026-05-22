/**
 * Semantic CAPTCHA Resolver
 * Detects CAPTCHA from the Semantic Page Model and resolves via solving services.
 * Operates on structured data, not Playwright page objects.
 */

import type { SemanticPage } from "./semantic-page.ts";

export interface CaptchaConfig {
  apiKey: string;
  service: "2captcha" | "anti-captcha" | "capsolver";
  timeoutMs?: number;
}

export interface CaptchaResult {
  solved: boolean;
  token?: string;
  answer?: string;
  error?: string;
}

const SERVICE_URLS: Record<string, string> = {
  "2captcha": "https://api.2captcha.com",
  "anti-captcha": "https://api.anti-captcha.com",
  "capsolver": "https://api.capsolver.com",
};

export class SemanticCaptchaResolver {
  private config: CaptchaConfig;

  constructor(config: CaptchaConfig) {
    this.config = { timeoutMs: 120000, ...config };
  }

  detectCaptcha(page: SemanticPage): { type: string; nodeId?: number } | null {
    for (const el of [...page.interactive, ...page.forms.flatMap((f) => f.fields as unknown[])]) {
      const s = JSON.stringify(el).toLowerCase();
      if (s.includes("g-recaptcha") || s.includes("recaptcha")) return { type: "recaptcha_v2" };
      if (s.includes("h-captcha") || s.includes("hcaptcha")) return { type: "hcaptcha" };
    }
    for (const c of page.content) {
      const s = c.text.toLowerCase();
      if (s.includes("recaptcha")) return { type: "recaptcha_v2" };
      if (s.includes("hcaptcha")) return { type: "hcaptcha" };
    }
    for (const media of page.media) {
      if (media.src?.includes("captcha") || media.alt?.toLowerCase().includes("captcha")) {
        return { type: "image" };
      }
    }
    for (const form of page.forms) {
      for (const field of form.fields) {
        const fname = field.name.toLowerCase();
        const fplaceholder = (field.placeholder ?? "").toLowerCase();
        if (fname.includes("captcha") || fplaceholder.includes("captcha")) {
          return { type: "text" };
        }
      }
    }
    return null;
  }

  /**
   * Resolve CAPTCHA given the detected type and current page state.
   * Returns token/answer to inject back into the page.
   */
  async resolve(page: SemanticPage, pageUrl: string): Promise<CaptchaResult> {
    const detected = this.detectCaptcha(page);
    if (!detected) {
      return { solved: true };
    }

    switch (detected.type) {
      case "recaptcha_v2":
        return await this.solveReCaptchaV2(page, pageUrl);
      case "recaptcha_v3":
        return await this.solveReCaptchaV3(page, pageUrl);
      case "hcaptcha":
        return await this.solveHCaptcha(page, pageUrl);
      case "image":
        return await this.solveImageCaptcha(page);
      case "text":
        return await this.solveTextCaptcha(page);
      default:
        return { solved: false, error: `Unsupported CAPTCHA type: ${detected.type}` };
    }
  }

  private async solveTokenCaptcha(
    taskType: string,
    page: SemanticPage,
    pageUrl: string,
    extraTaskData?: Record<string, unknown>,
  ): Promise<CaptchaResult> {
    const pageJson = JSON.stringify(page);
    const siteKeyMatch = pageJson.match(/data-sitekey["']?\s*[:=]\s*["']([^"']+)/);
    const siteKey = siteKeyMatch?.[1];
    if (!siteKey) {
      return { solved: false, error: `Could not extract site key from semantic model for ${taskType}` };
    }
    const taskId = await this.submitTask(taskType, { websiteURL: pageUrl, websiteKey: siteKey, ...extraTaskData });
    if (!taskId) return { solved: false, error: "Failed to submit CAPTCHA task" };
    const solution = await this.pollResult(taskId);
    if (!solution) return { solved: false, error: "CAPTCHA solving timeout" };
    return { solved: true, token: solution };
  }

  private async solveReCaptchaV2(page: SemanticPage, pageUrl: string): Promise<CaptchaResult> {
    return this.solveTokenCaptcha("ReCaptchaV2TaskProxyless", page, pageUrl);
  }

  private async solveReCaptchaV3(page: SemanticPage, pageUrl: string): Promise<CaptchaResult> {
    return this.solveTokenCaptcha("RecaptchaV3TaskProxyless", page, pageUrl, { minScore: 0.3, pageAction: "submit" });
  }

  private async solveHCaptcha(page: SemanticPage, pageUrl: string): Promise<CaptchaResult> {
    return this.solveTokenCaptcha("HCaptchaTaskProxyless", page, pageUrl);
  }

  private async solveImageCaptcha(_page: SemanticPage): Promise<CaptchaResult> {
    // Would need to get the image source and send to solving service
    // For now, require manual intervention or vision model
    return {
      solved: false,
      error: "Image CAPTCHA requires vision model or manual intervention in semantic mode",
    };
  }

  private async solveTextCaptcha(_page: SemanticPage): Promise<CaptchaResult> {
    return {
      solved: false,
      error: "Text CAPTCHA requires vision model integration in semantic mode",
    };
  }

  private async submitTask(type: string, data: Record<string, unknown>): Promise<string | null> {
    const base = SERVICE_URLS[this.config.service];
    if (!base) return null;
    const url = `${base}/createTask`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: this.config.apiKey,
          task: { type, ...data },
        }),
      });

      const result = await response.json();
      if (result.errorId === 0) {
        return result.taskId as string;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async pollResult(taskId: string): Promise<string | null> {
    const base = SERVICE_URLS[this.config.service];
    if (!base) return null;
    const url = `${base}/getTaskResult`;

    const deadline = Date.now() + (this.config.timeoutMs ?? 120000);

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: this.config.apiKey, taskId }),
        });

        const result = await response.json();
        if (result.status === "ready" && result.solution) {
          return (
            result.solution.gRecaptchaResponse ||
            result.solution.token ||
            result.solution.text ||
            result.solution.answer ||
            ""
          ) as string;
        }
        if (result.errorId !== 0) {
          return null;
        }
      } catch {
        // Network error, retry
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    return null;
  }
}
