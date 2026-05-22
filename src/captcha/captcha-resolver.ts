import type { Page } from "playwright";

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

export class CaptchaResolver {
  private config: CaptchaConfig;

  constructor(config: CaptchaConfig) {
    this.config = { timeoutMs: 120000, ...config };
  }

  async resolve(page: Page): Promise<CaptchaResult> {
    // Detect CAPTCHA type
    const captchaType = await this.detectCaptchaType(page);

    if (!captchaType) {
      return { solved: true }; // No CAPTCHA detected
    }

    switch (captchaType) {
      case "recaptcha_v2":
        return await this.solveReCaptchaV2(page);
      case "recaptcha_v3":
        return await this.solveReCaptchaV3(page);
      case "hcaptcha":
        return await this.solveHCaptcha(page);
      case "image":
        return await this.solveImageCaptcha(page);
      case "text":
        return await this.solveTextCaptcha(page);
      default:
        return { solved: false, error: `Unsupported CAPTCHA type: ${captchaType}` };
    }
  }

  private async detectCaptchaType(page: Page): Promise<string | null> {
    // Check for reCAPTCHA v2
    const hasReCaptchaV2 = await page.locator('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"]').count() > 0;
    if (hasReCaptchaV2) return "recaptcha_v2";

    // Check for reCAPTCHA v3 (invisible)
    const hasReCaptchaV3 = await page.evaluate(() => {
      // @ts-expect-error
      return typeof grecaptcha !== "undefined" && !!window.grecaptcha;
    }).catch(() => false);
    if (hasReCaptchaV3) return "recaptcha_v3";

    // Check for hCaptcha
    const hasHCaptcha = await page.locator('.h-captcha, [data-sitekey]:not(.g-recaptcha), iframe[src*="hcaptcha"]').count() > 0;
    if (hasHCaptcha) return "hcaptcha";

    // Check for image CAPTCHA
    const hasImageCaptcha = await page.locator('img[src*="captcha"], img[alt*="captcha" i], .captcha-image').count() > 0;
    if (hasImageCaptcha) return "image";

    // Check for text-based CAPTCHA (simple math, text challenge)
    const hasTextCaptcha = await page.locator('input[name*="captcha" i], input[placeholder*="captcha" i]').count() > 0;
    if (hasTextCaptcha) return "text";

    return null;
  }

  private async solveReCaptchaV2(page: Page): Promise<CaptchaResult> {
    try {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('.g-recaptcha');
        return el?.getAttribute('data-sitekey') || null;
      });

      if (!siteKey) {
        return { solved: false, error: "Could not extract reCAPTCHA site key" };
      }

      const pageUrl = page.url();

      // Submit to solving service
      const taskId = await this.submitTask("ReCaptchaV2TaskProxyless", {
        websiteURL: pageUrl,
        websiteKey: siteKey,
      });

      if (!taskId) {
        return { solved: false, error: "Failed to submit CAPTCHA task" };
      }

      const solution = await this.pollResult(taskId);
      if (!solution) {
        return { solved: false, error: "CAPTCHA solving timeout" };
      }

      // Inject solution into page
      await page.evaluate((token) => {
        // @ts-expect-error
        if (window.grecaptcha) {
          // @ts-expect-error
          grecaptcha.getResponse = () => token;
          // @ts-expect-error
          grecaptcha.lastResponse = token;
        }
        // Also update any textarea
        const textarea = document.querySelector('textarea[id*="g-recaptcha"], textarea[name="g-recaptcha-response"]');
        if (textarea) textarea.textContent = token;
      }, solution);

      return { solved: true, token: solution };
    } catch (err) {
      return {
        solved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async solveReCaptchaV3(page: Page): Promise<CaptchaResult> {
    // reCAPTCHA v3 is invisible and returns a score
    // We can't easily "solve" it — instead, use stealth techniques to get a good score
    // If that fails, report error
    try {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el?.getAttribute('data-sitekey') || null;
      });

      if (!siteKey) {
        return { solved: false, error: "Could not extract reCAPTCHA v3 site key" };
      }

      const pageUrl = page.url();
      const taskId = await this.submitTask("RecaptchaV3TaskProxyless", {
        websiteURL: pageUrl,
        websiteKey: siteKey,
        minScore: 0.3,
        pageAction: "submit",
      });

      if (!taskId) {
        return { solved: false, error: "Failed to submit CAPTCHA task" };
      }

      const solution = await this.pollResult(taskId);
      if (!solution) {
        return { solved: false, error: "CAPTCHA solving timeout" };
      }

      return { solved: true, token: solution };
    } catch (err) {
      return {
        solved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async solveHCaptcha(page: Page): Promise<CaptchaResult> {
    try {
      const siteKey = await page.evaluate(() => {
        const el = document.querySelector('.h-captcha, [data-sitekey]');
        return el?.getAttribute('data-sitekey') || null;
      });

      if (!siteKey) {
        return { solved: false, error: "Could not extract hCaptcha site key" };
      }

      const pageUrl = page.url();
      const taskId = await this.submitTask("HCaptchaTaskProxyless", {
        websiteURL: pageUrl,
        websiteKey: siteKey,
      });

      if (!taskId) {
        return { solved: false, error: "Failed to submit CAPTCHA task" };
      }

      const solution = await this.pollResult(taskId);
      if (!solution) {
        return { solved: false, error: "CAPTCHA solving timeout" };
      }

      // Inject solution
      await page.evaluate((token) => {
        const textarea = document.querySelector('textarea[name="h-captcha-response"]');
        if (textarea) textarea.textContent = token;
      }, solution);

      return { solved: true, token: solution };
    } catch (err) {
      return {
        solved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async solveImageCaptcha(page: Page): Promise<CaptchaResult> {
    try {
      // Find CAPTCHA image
      const imgSelector = 'img[src*="captcha"], img[alt*="captcha" i], .captcha-image';
      const img = page.locator(imgSelector).first();
      const count = await img.count();
      if (count === 0) {
        return { solved: false, error: "CAPTCHA image not found" };
      }

      // Take screenshot of the image
      const buffer = await img.screenshot();
      const base64 = buffer.toString("base64");

      // Submit to solving service as image
      const taskId = await this.submitTask("ImageToTextTask", {
        body: base64,
      });

      if (!taskId) {
        return { solved: false, error: "Failed to submit image CAPTCHA task" };
      }

      const answer = await this.pollResult(taskId);
      if (!answer) {
        return { solved: false, error: "CAPTCHA solving timeout" };
      }

      // Find and fill input field
      const inputSelectors = [
        'input[name*="captcha" i]',
        'input[placeholder*="captcha" i]',
        'input[id*="captcha" i]',
      ];

      for (const selector of inputSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          await page.locator(selector).first().fill(answer);
          break;
        }
      }

      return { solved: true, answer };
    } catch (err) {
      return {
        solved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async solveTextCaptcha(page: Page): Promise<CaptchaResult> {
    // For text-based challenges, we'd need a vision model to read and solve
    // This is a placeholder for vision-based CAPTCHA solving
    return {
      solved: false,
      error: "Text-based CAPTCHA requires vision model integration. Use image CAPTCHA solver or manual intervention.",
    };
  }

  private async submitTask(type: string, data: Record<string, unknown>): Promise<string | null> {
    const apiUrls: Record<string, string> = {
      "2captcha": "https://api.2captcha.com/createTask",
      "anti-captcha": "https://api.anti-captcha.com/createTask",
      "capsolver": "https://api.capsolver.com/createTask",
    };

    const url = apiUrls[this.config.service];
    if (!url) return null;

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
    const apiUrls: Record<string, string> = {
      "2captcha": "https://api.2captcha.com/getTaskResult",
      "anti-captcha": "https://api.anti-captcha.com/getTaskResult",
      "capsolver": "https://api.capsolver.com/getTaskResult",
    };

    const url = apiUrls[this.config.service];
    if (!url) return null;

    const startTime = Date.now();
    const timeout = this.config.timeoutMs ?? 120000;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientKey: this.config.apiKey,
            taskId,
          }),
        });

        const result = await response.json();

        if (result.status === "ready" && result.solution) {
          return (result.solution.gRecaptchaResponse ||
            result.solution.token ||
            result.solution.text ||
            result.solution.answer ||
            "") as string;
        }

        if (result.errorId !== 0) {
          return null;
        }
      } catch {
        // Network error, retry
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    return null;
  }
}
