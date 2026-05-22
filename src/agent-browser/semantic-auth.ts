/**
 * Semantic Auth Handler
 * Detects login forms from the Semantic Page Model and auto-fills credentials.
 * No Playwright locators — operates purely on structured data.
 */

import { createHmac } from "crypto";
import type { SemanticPage, SemanticForm } from "./semantic-page.ts";
import type { CDPBridge } from "./cdp-bridge.ts";

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

export class SemanticAuthHandler {
  private vault = new Map<string, AuthConfig>();

  configure(site: string, credentials: AuthCredentials, mfaType?: "totp" | "sms" | "none"): void {
    this.vault.set(site, { site, credentials, mfaType });
  }

  /**
   * Check if the current page is a login page by looking at the semantic model.
   * Returns the auth form if found.
   */
  detectLoginForm(page: SemanticPage): SemanticForm | null {
    for (const form of page.forms) {
      if (form.purpose === "authentication") {
        return form;
      }
      // Heuristic: form has password field
      if (form.fields.some((f) => f.type === "password")) {
        return form;
      }
    }
    return null;
  }

  /**
   * Attempt automatic login using the semantic page model.
   * Returns CDP actions to execute, NOT Playwright locators.
   */
  async authenticate(page: SemanticPage, site: string, cdp: CDPBridge): Promise<AuthResult> {
    const form = this.detectLoginForm(page);
    if (!form) {
      return { success: true }; // No login needed
    }

    const config = this.vault.get(site);
    if (!config) {
      return { success: false, error: `Login required but no auth configured for ${site}` };
    }

    // Find username/email field
    const usernameField = form.fields.find(
      (f) => f.type === "email" || f.name.toLowerCase().includes("email") || f.name.toLowerCase().includes("user")
    );
    // Find password field
    const passwordField = form.fields.find((f) => f.type === "password");
    // Find submit button
    const submitBtn = form.actions.find(
      (a) => a.type === "submit" || a.action === "login" || a.label.toLowerCase().includes("sign in") || a.label.toLowerCase().includes("log in")
    );

    if (!usernameField || !passwordField) {
      return { success: false, error: "Could not detect login form fields from semantic model" };
    }

    try {
      // Resolve fields to DOM node IDs and fill them
      const doc = await cdp.getDocument();

      // Fill username
      const usernameSelector = usernameField.name
        ? `[name="${usernameField.name}"]`
        : `input[type="email"]`;
      const usernameNode = await cdp.querySelector(doc.root.nodeId, usernameSelector);
      if (usernameNode?.nodeId && config.credentials.username) {
        await cdp.setInputValue(usernameNode.nodeId, config.credentials.username);
      }

      // Fill password
      const passwordSelector = passwordField.name
        ? `[name="${passwordField.name}"]`
        : `input[type="password"]`;
      const passwordNode = await cdp.querySelector(doc.root.nodeId, passwordSelector);
      if (passwordNode?.nodeId && config.credentials.password) {
        await cdp.setInputValue(passwordNode.nodeId, config.credentials.password);
      }

      // Click submit
      if (submitBtn) {
        const submitSelectors = [
          submitBtn.name ? `[name="${submitBtn.name}"]` : null,
          `button[type="submit"]`,
          `input[type="submit"]`,
        ].filter(Boolean) as string[];

        for (const selector of submitSelectors) {
          try {
            const node = await cdp.querySelector(doc.root.nodeId, selector);
            if (node?.nodeId) {
              await cdp.clickElement(node.nodeId);
              break;
            }
          } catch {
            // Try next selector
          }
        }
      } else {
        // Press Enter on password field
        await cdp.pressKey("Enter");
      }

      // Wait for navigation
      await new Promise((r) => setTimeout(r, 3000));

      // Check for MFA
      const mfaResult = await this.handleMFA(cdp, config, doc);
      if (!mfaResult.success) {
        return mfaResult;
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleMFA(cdp: CDPBridge, config: AuthConfig, doc: Awaited<ReturnType<CDPBridge["getDocument"]>>): Promise<AuthResult> {
    if (!config.mfaType || config.mfaType === "none") {
      return { success: true };
    }

    if (config.mfaType === "totp" && config.credentials.totpSecret) {
      const selectors = [
        'input[name="otp"]',
        'input[name="code"]',
        'input[name="totp"]',
        'input[name*="mfa"]',
        'input[name*="2fa"]',
        'input[placeholder*="code" i]',
        'input[type="tel"]',
      ];

      for (const selector of selectors) {
        try {
          const node = await cdp.querySelector(doc.root.nodeId, selector);
          if (node?.nodeId) {
            const code = this.generateTOTP(config.credentials.totpSecret!);
            await cdp.setInputValue(node.nodeId, code);

            // Try to find and click verify button
            const verifySelectors = [
              'button[type="submit"]',
              'input[type="submit"]',
            ];
            for (const vs of verifySelectors) {
              try {
                const vNode = await cdp.querySelector(doc.root.nodeId, vs);
                if (vNode?.nodeId) {
                  await cdp.clickElement(vNode.nodeId);
                  break;
                }
              } catch {
                // Try next
              }
            }

            return { success: true };
          }
        } catch {
          // Try next selector
        }
      }

      return { success: false, error: "MFA field not found on page" };
    }

    if (config.mfaType === "sms") {
      return {
        success: false,
        error: "SMS MFA requires external SMS service integration. Not yet implemented.",
      };
    }

    return { success: false, error: "MFA required but not configured" };
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
