import type { Page, Locator } from "playwright";

export interface DomAction {
  type: "click" | "type" | "select" | "scroll" | "wait" | "navigate" | "press";
  target?: string; // selector or URL for press: key name e.g. "Enter"
  value?: string;
  timeout?: number;
}

export interface DomResult {
  success: boolean;
  action: string;
  selector?: string;
  error?: string;
  html?: string;
}

interface ElementMeta {
  selector: string;
  tag: string;
  type: string;
  id: string;
  name: string;
  placeholder: string;
  ariaLabel: string;
  dataTestId: string;
  label: string;     // text of associated <label>
  textContent: string;
  role: string;
  score: number;
}

/**
 * Executes DOM-based actions on a Playwright page.
 * Used as fallback when API replay is not available.
 */
export class DomController {
  async execute(page: Page, actions: DomAction[]): Promise<DomResult[]> {
    const results: DomResult[] = [];

    for (const action of actions) {
      try {
        const result = await this.performAction(page, action);
        results.push(result);
        if (!result.success) break;
      } catch (err) {
        results.push({
          success: false,
          action: action.type,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    return results;
  }

  private async performAction(page: Page, action: DomAction): Promise<DomResult> {
    switch (action.type) {
      case "navigate": {
        if (!action.target) throw new Error("Navigate action requires target URL");
        try {
          await page.goto(action.target, { waitUntil: "networkidle", timeout: 12000 });
        } catch {
          await page.goto(action.target, { waitUntil: "domcontentloaded", timeout: 15000 });
        }
        return { success: true, action: "navigate", selector: action.target };
      }

      case "click": {
        if (!action.target) throw new Error("Click action requires target selector");
        await this.smartClick(page, action.target);
        return { success: true, action: "click", selector: action.target };
      }

      case "type": {
        if (!action.target || action.value === undefined) {
          throw new Error("Type action requires target selector and value");
        }
        await this.humanType(page.locator(action.target).first(), action.value);
        return { success: true, action: "type", selector: action.target };
      }

      case "select": {
        if (!action.target || action.value === undefined) {
          throw new Error("Select action requires target selector and value");
        }
        await page.locator(action.target).first().selectOption(action.value);
        return { success: true, action: "select", selector: action.target };
      }

      case "scroll": {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        return { success: true, action: "scroll" };
      }

      case "press": {
        // Press a keyboard key — optionally focused on a selector
        const key = action.target ?? "Enter";
        if (action.value) {
          await page.locator(action.value).first().press(key);
        } else {
          await page.keyboard.press(key);
        }
        return { success: true, action: "press", selector: key };
      }

      case "wait": {
        await page.waitForTimeout(action.timeout ?? 1000);
        return { success: true, action: "wait" };
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  private async smartClick(page: Page, selector: string): Promise<void> {
    // Try direct selector first
    let locator = page.locator(selector);
    if (await locator.count() === 0) {
      // Try as text match
      locator = page.getByText(selector, { exact: false });
    }
    if (await locator.count() === 0) {
      // Try role-based
      locator = page.getByRole("button", { name: selector });
    }
    if (await locator.count() === 0) {
      throw new Error(`Element not found: ${selector}`);
    }

    await locator.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(80 + Math.random() * 120);

    const box = await locator.first().boundingBox();
    if (box) {
      const x = box.x + box.width * (0.3 + Math.random() * 0.4);
      const y = box.y + box.height * (0.3 + Math.random() * 0.4);
      await page.mouse.move(x, y, { steps: 5 });
      await page.waitForTimeout(40 + Math.random() * 80);
      await page.mouse.click(x, y);
    } else {
      await locator.first().click();
    }
  }

  private async humanType(locator: Locator, text: string): Promise<void> {
    await locator.fill("");
    await locator.focus();
    // Always use fill for reliability; pressSequentially is slow and flaky at scale
    await locator.fill(text);
  }

  /**
   * Snapshot all interactive elements in one evaluate call (fast),
   * then score each against intent keywords.
   */
  async detectElements(page: Page, intent: string): Promise<Record<string, string>> {
    const keywords = intent.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

    // Grab all element metadata in a single page.evaluate — much faster than per-element calls
    const rawElements: Omit<ElementMeta, "score">[] = await page.evaluate(() => {
      const result: Omit<ElementMeta, "score">[] = [];
      const interactable = document.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, button, a[href], [role="button"], [role="link"], [role="searchbox"], [role="combobox"]'
      );

      for (const el of Array.from(interactable)) {
        const htmlEl = el as HTMLElement;
        const id = htmlEl.getAttribute("id") ?? "";

        // Build a robust selector — priority: id > name > data-testid > aria-label > text
        let selector = "";
        if (id) {
          selector = `#${CSS.escape(id)}`;
        } else if (htmlEl.getAttribute("name")) {
          selector = `[name="${htmlEl.getAttribute("name")}"]`;
        } else if (htmlEl.dataset.testid) {
          selector = `[data-testid="${htmlEl.dataset.testid}"]`;
        } else if (htmlEl.getAttribute("aria-label")) {
          selector = `[aria-label="${htmlEl.getAttribute("aria-label")}"]`;
        } else if (htmlEl.getAttribute("role")) {
          const role = htmlEl.getAttribute("role")!;
          if (!["textbox","searchbox","combobox","listbox"].includes(role)) {
            selector = `[role="${role}"]`;
          }
        }

        if (!selector) {
          // Build tag+type selector — use actual tag name (input vs button)
          const tag = htmlEl.tagName.toLowerCase();
          const type = htmlEl.getAttribute("type") ?? "";
          if (type && type !== "text") {
            selector = `${tag}[type="${type}"]`;
          } else if (tag === "button") {
            selector = "button";
          } else {
            selector = tag;
          }
        }

        // Find associated label text
        let labelText = "";
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`);
          if (labelEl) labelText = labelEl.textContent?.trim() ?? "";
        }
        if (!labelText) {
          const parentLabel = htmlEl.closest("label");
          if (parentLabel) labelText = parentLabel.textContent?.trim() ?? "";
        }

        result.push({
          selector,
          tag: htmlEl.tagName.toLowerCase(),
          type: htmlEl.getAttribute("type") ?? "",
          id,
          name: htmlEl.getAttribute("name") ?? "",
          placeholder: (htmlEl as HTMLInputElement).getAttribute?.("placeholder") ?? "",
          ariaLabel: htmlEl.getAttribute("aria-label") ?? "",
          dataTestId: htmlEl.dataset.testid ?? "",
          label: labelText,
          textContent: (htmlEl.textContent ?? "").trim().slice(0, 80),
          role: htmlEl.getAttribute("role") ?? "",
        });
      }

      return result;
    });

    // Score each element against intent keywords
    const scored: ElementMeta[] = rawElements.map((el) => {
      // For keyword scoring, weight attributes by reliability
      // id/name/placeholder/ariaLabel >> textContent (button text is noisy)
      const primaryHaystack = [el.id, el.name, el.placeholder, el.ariaLabel, el.dataTestId, el.label, el.type, el.role].join(" ").toLowerCase();
      const secondaryHaystack = el.textContent.toLowerCase();

      let score = 0;
      for (const kw of keywords) {
        if (primaryHaystack.includes(kw)) score += 15;
        if (new RegExp(`\\b${kw}\\b`).test(primaryHaystack)) score += 8;
        // Secondary (button text) scores less — prevents submit buttons stealing field names
        if (secondaryHaystack.includes(kw)) score += 3;
        if (new RegExp(`\\b${kw}\\b`).test(secondaryHaystack)) score += 2;
      }
      // Boost actual input/textarea fields — they're more likely to be "the field"
      if (el.tag === "input" || el.tag === "textarea") score += 10;
      if (el.tag === "select") score += 5;
      // Boost well-known field types
      if (el.type === "submit") score -= 5; // submit buttons should NOT steal field names
      if (el.type === "email") score += 5;
      if (el.type === "password") score += 5;
      if (el.type === "search") score += 8;
      if (el.role === "searchbox" || el.role === "combobox") score += 6;

      return { ...el, score };
    });

    // Build named element map
    const elements: Record<string, string> = {};

    // Always register typed fields (inputs only — never let a button steal these)
    for (const el of scored) {
      if (el.type === "email") elements["email"] = el.selector;
      if (el.type === "password") elements["password"] = el.selector;
      if (el.type === "search" || el.role === "searchbox") elements["search"] = el.selector;
      if (el.type === "submit" && (el.tag === "input" || el.tag === "button")) {
        elements["submit"] = el.selector;
      }
    }

    // Register top-scoring match per keyword
    for (const kw of keywords) {
      const best = scored
        .filter((el) => {
          const haystack = [el.id, el.name, el.placeholder, el.ariaLabel, el.label, el.textContent, el.type].join(" ").toLowerCase();
          return haystack.includes(kw);
        })
        .sort((a, b) => b.score - a.score)[0];
      if (best && !elements[kw]) {
        elements[kw] = best.selector;
      }
    }

    // Best submit button if not already found
    if (!elements["submit"]) {
      const submitBtn = scored
        .filter((el) => el.tag === "button" || el.type === "submit" || el.role === "button")
        .filter((el) => {
          const text = (el.textContent + el.ariaLabel + el.label).toLowerCase();
          return text.includes("submit") || text.includes("search") || text.includes("sign in") || text.includes("log in") || text.includes("send");
        })
        .sort((a, b) => b.score - a.score)[0];
      if (submitBtn) elements["submit"] = submitBtn.selector;
    }

    return elements;
  }
}
