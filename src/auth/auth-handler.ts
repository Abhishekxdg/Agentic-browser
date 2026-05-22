import { createHmac } from "crypto";
import type { Page } from "playwright";

export interface AuthCredentials {
  username?: string;
  password?: string;
  totpSecret?: string;
  oauthProvider?: "google" | "github" | "microsoft" | string;
  oauthRefreshToken?: string;
  cookies?: Record<string, string>;
}

export interface AuthConfig {
  site: string;
  credentials: AuthCredentials;
  mfaType?: "totp" | "sms" | "none";
}

export interface AuthResult {
  success: boolean;
  authToken?: string;
  cookies?: Record<string, string>;
  error?: string;
}

export class AuthHandler {
  private vault = new Map<string, AuthConfig>();

  configure(site: string, credentials: AuthCredentials, mfaType?: "totp" | "sms" | "none"): void {
    this.vault.set(site, { site, credentials, mfaType });
  }

  async authenticate(page: Page, site: string): Promise<AuthResult> {
    // Check if site even needs auth
    const needsAuth = await this.detectsLoginPage(page);
    if (!needsAuth) {
      return { success: true };
    }

    const config = this.vault.get(site);
    if (!config) {
      return { success: false, error: `Login required but no auth configured for ${site}` };
    }

    // Check if already logged in
    const alreadyAuth = await this.isAuthenticated(page, site);
    if (alreadyAuth) {
      return { success: true };
    }

    // Try OAuth if configured
    if (config.credentials.oauthProvider && config.credentials.oauthRefreshToken) {
      return await this.handleOAuth(page, config);
    }

    // Try auto-detect login form
    return await this.handleFormLogin(page, config);
  }

  private async detectsLoginPage(page: Page): Promise<boolean> {
    const hasPasswordField = await page.locator('input[type="password"]').count() > 0;
    const url = page.url();
    // Only require auth if we're on an actual login page with a password field,
    // OR the URL is explicitly a login/authentication endpoint
    const isLoginUrl = /\/(login|signin|auth|authenticate)(\/|$|\?)/i.test(new URL(url).pathname);
    return hasPasswordField && isLoginUrl;
  }

  private async isAuthenticated(page: Page, site: string): Promise<boolean> {
    // Heuristic: check for login form or auth-specific elements
    const hasLoginForm = await page.locator('input[type="password"]').count() > 0;
    const hasAuthButton = await page.locator('text=/sign\\s*in|log\\s*in/i').count() > 0;
    const currentUrl = page.url();

    // If on login page, not authenticated
    if (currentUrl.includes("login") || currentUrl.includes("signin")) {
      return !hasLoginForm;
    }

    // If no login form visible, assume authenticated
    return !hasLoginForm && !hasAuthButton;
  }

  private async handleFormLogin(page: Page, config: AuthConfig): Promise<AuthResult> {
    try {
      // Auto-detect login form fields
      const usernameSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[id*="email"]',
        'input[id*="user"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="username" i]',
      ];

      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[id*="password"]',
      ];

      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
      ];

      // Find username field
      let usernameField = null;
      for (const selector of usernameSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          usernameField = selector;
          break;
        }
      }

      // Find password field
      let passwordField = null;
      for (const selector of passwordSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          passwordField = selector;
          break;
        }
      }

      if (!usernameField || !passwordField) {
        return { success: false, error: "Could not detect login form fields" };
      }

      // Fill credentials with human-like delays
      await this.humanType(page.locator(usernameField), config.credentials.username ?? "");
      await page.waitForTimeout(300 + Math.random() * 400);
      await this.humanType(page.locator(passwordField), config.credentials.password ?? "");
      await page.waitForTimeout(200 + Math.random() * 300);

      // Click submit
      let submitClicked = false;
      for (const selector of submitSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          await page.locator(selector).first().click();
          submitClicked = true;
          break;
        }
      }

      if (!submitClicked) {
        // Try pressing Enter on password field
        await page.locator(passwordField).press("Enter");
      }

      // Wait for navigation or MFA prompt
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      // Check for MFA
      const mfaResult = await this.handleMFA(page, config);
      if (!mfaResult.success) {
        return mfaResult;
      }

      // Verify logged in
      const nowAuth = await this.isAuthenticated(page, config.site);
      if (!nowAuth) {
        return { success: false, error: "Login failed — still on login page or form visible" };
      }

      // Extract session cookies
      const cookies = await page.context().cookies();
      const cookieMap: Record<string, string> = {};
      for (const c of cookies) {
        cookieMap[c.name] = c.value;
      }

      return { success: true, cookies: cookieMap };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleMFA(page: Page, config: AuthConfig): Promise<AuthResult> {
    if (!config.mfaType || config.mfaType === "none") {
      return { success: true };
    }

    // Detect MFA input
    const mfaSelectors = [
      'input[name="otp"]',
      'input[name="code"]',
      'input[name="totp"]',
      'input[name*="mfa"]',
      'input[name*="2fa"]',
      'input[placeholder*="code" i]',
      'input[type="tel"]',
    ];

    let mfaField = null;
    for (const selector of mfaSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        mfaField = selector;
        break;
      }
    }

    if (!mfaField) {
      // No MFA prompt detected
      return { success: true };
    }

    if (config.mfaType === "totp" && config.credentials.totpSecret) {
      const code = this.generateTOTP(config.credentials.totpSecret);
      await this.humanType(page.locator(mfaField), code);
      await page.waitForTimeout(300);

      // Find and click submit
      const submitSelectors = [
        'button[type="submit"]',
        'button:has-text("Verify")',
        'button:has-text("Continue")',
      ];
      for (const selector of submitSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          await page.locator(selector).first().click();
          break;
        }
      }

      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      return { success: true };
    }

    if (config.mfaType === "sms") {
      // For SMS, we'd need an external SMS service integration
      // This is a placeholder — in production, poll SMS webhook
      return {
        success: false,
        error: "SMS MFA requires external SMS service integration. Not yet implemented.",
      };
    }

    return { success: false, error: "MFA required but not configured" };
  }

  private async handleOAuth(page: Page, config: AuthConfig): Promise<AuthResult> {
    // OAuth flow: click provider button, handle popup, extract tokens
    // This is a simplified version — real OAuth requires PKCE, state, etc.
    try {
      const provider = config.credentials.oauthProvider!;
      const providerSelectors = [
        `button:has-text("${provider}")`,
        `a:has-text("${provider}")`,
        `[data-provider="${provider}"]`,
      ];

      for (const selector of providerSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          const popupPromise = page.waitForEvent("popup", { timeout: 10000 });
          await page.locator(selector).first().click();
          const popup = await popupPromise;
          await popup.waitForLoadState("networkidle");
          // In real implementation, complete OAuth flow in popup
          await popup.close();
          return { success: true };
        }
      }

      return { success: false, error: `OAuth provider ${provider} button not found` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async humanType(locator: ReturnType<Page["locator"]>, text: string): Promise<void> {
    // Clear field first
    await locator.fill("");
    await locator.focus();
    // Type with slight random delays between keystrokes for human-like behavior
    for (const char of text) {
      await locator.press(char);
      await locator.page().waitForTimeout(20 + Math.random() * 80);
    }
  }

  private generateTOTP(secret: string): string {
    const counter = Math.floor(Date.now() / 1000 / 30);

    const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const secretUpper = secret.toUpperCase().replace(/=+$/, "");
    let bits = "";
    for (const char of secretUpper) {
      const val = base32Chars.indexOf(char);
      if (val >= 0) bits += val.toString(2).padStart(5, "0");
    }

    const keyBytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      const byte = bits.slice(i, i + 8);
      if (byte.length === 8) keyBytes.push(parseInt(byte, 2));
    }

    const msg = Buffer.alloc(8);
    let temp = counter;
    for (let i = 7; i >= 0; i--) {
      msg[i] = temp & 0xff;
      temp >>= 8;
    }

    const hash = createHmac("sha1", Buffer.from(keyBytes)).update(msg).digest();
    const offset = hash[hash.length - 1]! & 0x0f;
    const code =
      (((hash[offset]! & 0x7f) << 24) |
        ((hash[offset + 1]! & 0xff) << 16) |
        ((hash[offset + 2]! & 0xff) << 8) |
        (hash[offset + 3]! & 0xff)) %
      1000000;

    return code.toString().padStart(6, "0");
  }
}
