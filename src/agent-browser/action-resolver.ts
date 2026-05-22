/**
 * Semantic Action Protocol (SAP)
 * Converts agent-level intent commands into CDP actions.
 * The agent never sees a CSS selector or coordinate.
 */

import type { CDPBridge } from "./cdp-bridge.ts";
import type { SemanticPage, SemanticForm, SemanticField } from "./semantic-page.ts";

export type SemanticAction =
  | { type: "navigate"; url: string }
  | { type: "fill"; form: string; field: string; value: string | number | boolean }
  | { type: "click"; target: string; context?: string }
  | { type: "select"; form: string; field: string; option: string }
  | { type: "scroll"; direction: "up" | "down" | "top" | "bottom"; amount?: number }
  | { type: "wait"; condition: "page.load" | "network.idle" | "time"; ms?: number }
  | { type: "press"; key: string }
  | { type: "extract"; what: string } // "page.forms", "page.tables", "page.content"
  | { type: "open_tab"; url?: string }
  | { type: "switch_tab"; tabId: string }
  | { type: "close_tab"; tabId: string }
  | { type: "list_tabs" }
  | { type: "screenshot"; fullPage?: boolean }
  | { type: "hover"; target: string; context?: string }
  | { type: "double_click"; target: string; context?: string }
  | { type: "right_click"; target: string; context?: string }
  | { type: "history"; direction: "back" | "forward" | "refresh" }
  | { type: "get_cookies"; url?: string }
  | { type: "set_cookie"; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number }
  | { type: "clear_cookies" }
  | { type: "handle_dialog"; accept: boolean; text?: string }
  | { type: "upload_file"; target: string; files: string[] }
  | { type: "wait_for"; selector: string; timeoutMs?: number }
  | { type: "keyboard_shortcut"; modifiers: Array<"Alt" | "Ctrl" | "Meta" | "Shift">; key: string }
  | { type: "get_storage"; storageType: "local" | "session" }
  | { type: "set_storage"; storageType: "local" | "session"; key: string; value: string }
  | { type: "drag_drop"; from: string; to: string }
  | { type: "get_text"; selector: string }
  | { type: "get_iframes" }
  | { type: "type_text"; text: string }
  | { type: "click_selector"; selector: string }
  | { type: "fill_selector"; selector: string; value: string }
  | { type: "focus_selector"; selector: string }
  | { type: "click_text"; text: string }
  | { type: "click_coords"; x: number; y: number };

export type ActionStrategy =
  | "semantic_label_match"
  | "semantic_form_field"
  | "visible_text_exact"
  | "visible_text_partial"
  | "css_selector"
  | "aria_label"
  | "name_attr"
  | "js_eval"
  | "navigate"
  | "keyboard"
  | "scroll"
  | "wait"
  | "direct";

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  confidence?: number;   // 0.0 - 1.0: how certain the action targeted the right element
  strategy?: ActionStrategy; // which resolution path succeeded
}

/**
 * Execute a semantic action against the current page.
 * Resolves semantic names (like "login.email") to actual DOM elements via CDP.
 */
export async function executeSemanticAction(
  cdp: CDPBridge,
  page: SemanticPage,
  action: SemanticAction,
): Promise<ActionResult> {
  switch (action.type) {
    case "navigate":
      return await doNavigate(cdp, action.url);

    case "fill":
      return await doFill(cdp, page, action.form, action.field, action.value);

    case "click":
      return await doClick(cdp, page, action.target, action.context);

    case "select":
      return await doSelect(cdp, page, action.form, action.field, action.option);

    case "scroll":
      return await doScroll(cdp, action.direction, action.amount);

    case "wait":
      return await doWait(cdp, action);

    case "press":
      return await doPress(cdp, action.key);

    case "extract":
      return await doExtract(page, action.what);

    case "open_tab":
      return await doOpenTab(cdp, action.url);

    case "switch_tab":
      return await doSwitchTab(cdp, action.tabId);

    case "close_tab":
      return await doCloseTab(cdp, action.tabId);

    case "list_tabs":
      return await doListTabs(cdp);

    case "screenshot":
      return await doScreenshot(cdp, action.fullPage);

    case "hover":
      return await doHover(cdp, page, action.target, action.context);

    case "double_click":
      return await doDoubleClick(cdp, page, action.target, action.context);

    case "right_click":
      return await doRightClick(cdp, page, action.target, action.context);

    case "history":
      return await doHistory(cdp, action.direction);

    case "get_cookies":
      return await doGetCookies(cdp, action.url);

    case "set_cookie":
      return await doSetCookie(cdp, action);

    case "clear_cookies":
      return await doClearCookies(cdp);

    case "handle_dialog":
      return await doHandleDialog(cdp, action.accept, action.text);

    case "upload_file":
      return await doUploadFile(cdp, page, action.target, action.files);

    case "wait_for":
      return await doWaitFor(cdp, action.selector, action.timeoutMs);

    case "keyboard_shortcut":
      return await doKeyboardShortcut(cdp, action.modifiers, action.key);

    case "get_storage":
      return await doGetStorage(cdp, action.storageType);

    case "set_storage":
      return await doSetStorage(cdp, action.storageType, action.key, action.value);

    case "drag_drop":
      return await doDragDrop(cdp, page, action.from, action.to);

    case "get_text":
      return await doGetText(cdp, action.selector);

    case "get_iframes":
      return await doGetIframes(cdp);

    case "type_text":
      return await doTypeText(cdp, action.text);

    case "click_selector":
      return await doClickSelector(cdp, action.selector);

    case "fill_selector":
      return await doFillSelector(cdp, action.selector, action.value);

    case "focus_selector":
      return await doFocusSelector(cdp, action.selector);

    case "click_text":
      return await doClickText(cdp, action.text);

    case "click_coords":
      try {
        await cdp.clickAt(action.x, action.y);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

    default:
      return { success: false, error: `Unknown action type: ${(action as SemanticAction).type}` };
  }
}

async function doNavigate(cdp: CDPBridge, url: string): Promise<ActionResult> {
  try {
    await cdp.navigate(url);
    return { success: true, confidence: 1.0, strategy: "navigate" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doFill(
  cdp: CDPBridge,
  page: SemanticPage,
  formHint: string,
  fieldHint: string,
  value: string | number | boolean,
): Promise<ActionResult> {
  const stringValue = String(value);

  // Tier 1: semantic resolution via page model
  const form = findForm(page, formHint);
  if (form) {
    const field = findField(form, fieldHint);
    if (field) {
      const nodeId = await resolveFieldToNodeId(cdp, form, field);
      if (nodeId) {
        try {
          await cdp.setInputValue(nodeId, stringValue);
          return { success: true, confidence: 0.95, strategy: "semantic_form_field" };
        } catch { /* fall through */ }
      }
    }
  }

  // Tier 2: fill by name/id/placeholder attribute
  const byAttr = await doFillSelector(cdp,
    `input[name="${fieldHint}"], input[id="${fieldHint}"], input[placeholder="${fieldHint}"], textarea[name="${fieldHint}"]`,
    stringValue,
  );
  if (byAttr.success) return { ...byAttr, confidence: 0.75, strategy: "name_attr" };

  // Tier 3: fill by aria-label
  const byLabel = await doFillSelector(cdp, `[aria-label="${fieldHint}"]`, stringValue);
  if (byLabel.success) return { ...byLabel, confidence: 0.70, strategy: "aria_label" };

  return { success: false, error: `Could not fill field "${fieldHint}" in form "${formHint}" — tried semantic, name attr, and aria-label` };
}

async function doClick(
  cdp: CDPBridge,
  page: SemanticPage,
  targetHint: string,
  contextHint?: string,
): Promise<ActionResult> {
  // Tier 1: semantic resolution via page model
  const resolved = await resolveClickTarget(cdp, page, targetHint, contextHint);
  if (resolved) {
    try {
      await cdp.clickElement(resolved.nodeId);
      return { success: true, confidence: 0.95, strategy: "semantic_label_match" };
    } catch { /* fall through */ }
  }

  // Tier 2: click by visible text
  const byText = await doClickText(cdp, targetHint);
  if (byText.success) return { ...byText, confidence: 0.80, strategy: "visible_text_exact" };

  // Tier 3: click by CSS selector (treat targetHint as selector if it looks like one)
  if (/^[#.\[]/.test(targetHint)) {
    const bySelector = await doClickSelector(cdp, targetHint);
    if (bySelector.success) return bySelector;
  }

  // Tier 4: partial text match via JS
  const byPartial = await doClickTextPartial(cdp, targetHint);
  if (byPartial.success) return { ...byPartial, confidence: 0.55, strategy: "visible_text_partial" };

  return { success: false, error: `Could not click "${targetHint}" — tried semantic, text, selector, and partial text` };
}

async function doSelect(
  cdp: CDPBridge,
  page: SemanticPage,
  formHint: string,
  fieldHint: string,
  option: string,
): Promise<ActionResult> {
  const form = findForm(page, formHint);
  if (!form) {
    return { success: false, error: `Form "${formHint}" not found` };
  }

  const field = findField(form, fieldHint);
  if (!field) {
    return { success: false, error: `Field "${fieldHint}" not found` };
  }

  const nodeId = await resolveFieldToNodeId(cdp, form, field);
  if (!nodeId) {
    return { success: false, error: `Could not resolve field to DOM element` };
  }

  try {
    await cdp.selectOption(nodeId, option);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doScroll(cdp: CDPBridge, direction: "up" | "down" | "top" | "bottom", amount?: number): Promise<ActionResult> {
  try {
    await cdp.scroll(direction, amount);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForNetworkIdle(cdp: CDPBridge, timeoutMs: number): Promise<void> {
  let inFlight = 0;
  let quietSince = Date.now();
  const QUIET_WINDOW = 500; // ms of no activity = idle

  const onRequest = () => { inFlight++; quietSince = 0; };
  const onFinish = () => { inFlight = Math.max(0, inFlight - 1); if (inFlight === 0) quietSince = Date.now(); };
  const onFail = onFinish;

  cdp.on("Network.requestWillBeSent", onRequest);
  cdp.on("Network.loadingFinished", onFinish);
  cdp.on("Network.loadingFailed", onFail);

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (inFlight === 0 && quietSince > 0 && Date.now() - quietSince >= QUIET_WINDOW) break;
    }
  } finally {
    cdp.off("Network.requestWillBeSent", onRequest);
    cdp.off("Network.loadingFinished", onFinish);
    cdp.off("Network.loadingFailed", onFail);
  }
}

async function doWait(cdp: CDPBridge, action: Extract<SemanticAction, { type: "wait" }>): Promise<ActionResult> {
  try {
    if (action.condition === "page.load") {
      await cdp.waitForEvent("Page.loadEventFired", action.ms ?? 15000);
    } else if (action.condition === "network.idle") {
      // True network idle: no new requests for 500ms window, with max timeout
      await waitForNetworkIdle(cdp, action.ms ?? 8000);
    } else if (action.condition === "time") {
      await new Promise((r) => setTimeout(r, action.ms ?? 1000));
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doPress(cdp: CDPBridge, key: string): Promise<ActionResult> {
  try {
    await cdp.pressKey(key);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doExtract(page: SemanticPage, what: string): Promise<ActionResult> {
  const lower = what.toLowerCase();
  try {
    if (lower === "page.forms" || lower === "forms") {
      return { success: true, data: page.forms };
    }
    if (lower === "page.tables" || lower === "tables") {
      return { success: true, data: page.tables };
    }
    if (lower === "page.content" || lower === "content") {
      return { success: true, data: page.content };
    }
    if (lower === "page.navigation" || lower === "navigation" || lower === "links") {
      return { success: true, data: page.navigation };
    }
    if (lower === "page.interactive" || lower === "interactive") {
      return { success: true, data: page.interactive };
    }
    if (lower === "page" || lower === "all") {
      return { success: true, data: page };
    }
    return { success: false, error: `Unknown extract target: "${what}"` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doScreenshot(cdp: CDPBridge, fullPage = false): Promise<ActionResult> {
  try {
    const data = await cdp.screenshot(fullPage);
    return { success: true, data: { base64: data, mimeType: "image/png" } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doHover(cdp: CDPBridge, page: SemanticPage, targetHint: string, contextHint?: string): Promise<ActionResult> {
  const resolved = await resolveClickTarget(cdp, page, targetHint, contextHint);
  if (!resolved) return { success: false, error: `Cannot resolve hover target "${targetHint}"` };
  try {
    await cdp.hoverElement(resolved.nodeId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doDoubleClick(cdp: CDPBridge, page: SemanticPage, targetHint: string, contextHint?: string): Promise<ActionResult> {
  const resolved = await resolveClickTarget(cdp, page, targetHint, contextHint);
  if (!resolved) return { success: false, error: `Cannot resolve double-click target "${targetHint}"` };
  try {
    await cdp.doubleClickElement(resolved.nodeId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doRightClick(cdp: CDPBridge, page: SemanticPage, targetHint: string, contextHint?: string): Promise<ActionResult> {
  const resolved = await resolveClickTarget(cdp, page, targetHint, contextHint);
  if (!resolved) return { success: false, error: `Cannot resolve right-click target "${targetHint}"` };
  try {
    await cdp.rightClickElement(resolved.nodeId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doHistory(cdp: CDPBridge, direction: "back" | "forward" | "refresh"): Promise<ActionResult> {
  try {
    await cdp.history(direction);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doGetCookies(cdp: CDPBridge, url?: string): Promise<ActionResult> {
  try {
    const cookies = await cdp.getCookies(url);
    return { success: true, data: cookies };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doSetCookie(cdp: CDPBridge, params: Extract<SemanticAction, { type: "set_cookie" }>): Promise<ActionResult> {
  try {
    await cdp.setCookie({ name: params.name, value: params.value, domain: params.domain, path: params.path, secure: params.secure, httpOnly: params.httpOnly, sameSite: params.sameSite, expires: params.expires });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doClearCookies(cdp: CDPBridge): Promise<ActionResult> {
  try {
    await cdp.clearCookies();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doHandleDialog(cdp: CDPBridge, accept: boolean, text?: string): Promise<ActionResult> {
  try {
    await cdp.handleDialog(accept, text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doUploadFile(cdp: CDPBridge, _page: SemanticPage, targetHint: string, files: string[]): Promise<ActionResult> {
  // Resolve the file input by semantic hint or CSS selector
  try {
    const doc = await cdp.getDocument();
    const selectors = [
      `input[type="file"][name="${targetHint}"]`,
      `input[type="file"][id="${targetHint}"]`,
      `input[type="file"]`,
    ];
    for (const selector of selectors) {
      const node = await cdp.querySelector(doc.root.nodeId, selector);
      if (node?.nodeId) {
        await cdp.uploadFile(node.nodeId, files);
        return { success: true };
      }
    }
    return { success: false, error: `File input "${targetHint}" not found` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doWaitFor(cdp: CDPBridge, selector: string, timeoutMs = 10000): Promise<ActionResult> {
  try {
    const nodeId = await cdp.waitForSelector(selector, timeoutMs);
    if (nodeId) return { success: true, data: { nodeId } };
    return { success: false, error: `Selector "${selector}" not found within ${timeoutMs}ms` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doKeyboardShortcut(cdp: CDPBridge, modifiers: Array<"Alt" | "Ctrl" | "Meta" | "Shift">, key: string): Promise<ActionResult> {
  try {
    await cdp.keyboardShortcut(modifiers, key);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doGetStorage(cdp: CDPBridge, storageType: "local" | "session"): Promise<ActionResult> {
  try {
    const data = storageType === "local" ? await cdp.getLocalStorage() : await cdp.getSessionStorage();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doSetStorage(cdp: CDPBridge, storageType: "local" | "session", key: string, value: string): Promise<ActionResult> {
  try {
    if (storageType === "local") await cdp.setLocalStorage(key, value);
    else await cdp.setSessionStorage(key, value);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doDragDrop(cdp: CDPBridge, page: SemanticPage, fromHint: string, toHint: string): Promise<ActionResult> {
  const from = await resolveClickTarget(cdp, page, fromHint);
  const to = await resolveClickTarget(cdp, page, toHint);
  if (!from) return { success: false, error: `Cannot resolve drag source "${fromHint}"` };
  if (!to) return { success: false, error: `Cannot resolve drag target "${toHint}"` };
  try {
    await cdp.dragDrop(from.nodeId, to.nodeId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doGetText(cdp: CDPBridge, selector: string): Promise<ActionResult> {
  try {
    const text = await cdp.getElementText(selector);
    return { success: true, data: { text } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doGetIframes(cdp: CDPBridge): Promise<ActionResult> {
  try {
    const iframes = await cdp.getIframeContents();
    return { success: true, data: iframes };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doTypeText(cdp: CDPBridge, text: string): Promise<ActionResult> {
  try {
    await cdp.typeText(text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doClickSelector(cdp: CDPBridge, selector: string, confidence = 0.65): Promise<ActionResult> {
  try {
    const result = await cdp.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
        if (el.click) el.click();
        return { found: true, tag: el.tagName };
      })()
    `) as { found: boolean; tag?: string };
    if (!result?.found) return { success: false, error: `Selector "${selector}" not found` };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doFillSelector(cdp: CDPBridge, selector: string, value: string): Promise<ActionResult> {
  try {
    await cdp.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
          'value'
        )?.set;
        if (nativeSetter) nativeSetter.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.focus();
      })()
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doFocusSelector(cdp: CDPBridge, selector: string): Promise<ActionResult> {
  try {
    await cdp.evaluate(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.focus();
    `);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doClickText(cdp: CDPBridge, text: string): Promise<ActionResult> {
  try {
    const result = await cdp.evaluate(`
      (function() {
        const lower = ${JSON.stringify(text.toLowerCase())};
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const t = (el.textContent || el.value || el.innerText || '').trim().toLowerCase();
          if (t === lower && el.offsetParent !== null) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
            if (el.click) el.click();
            return { found: true, tag: el.tagName };
          }
        }
        return { found: false };
      })()
    `) as { found: boolean; tag?: string };
    if (!result?.found) return { success: false, error: `No visible element with text "${text}" found` };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doClickTextPartial(cdp: CDPBridge, text: string): Promise<ActionResult> {
  try {
    const lower = JSON.stringify(text.toLowerCase());
    const result = await cdp.evaluate(`
      (function() {
        const lower = ${lower};
        const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]');
        for (const el of candidates) {
          const t = (el.textContent || el.value || el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
          if (t.includes(lower) && el.offsetParent !== null) {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
            if (el.click) el.click();
            return { found: true, tag: el.tagName, text: t };
          }
        }
        return { found: false };
      })()
    `) as { found: boolean; tag?: string; text?: string };
    if (!result?.found) return { success: false, error: `No element containing "${text}" found` };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doOpenTab(cdp: CDPBridge, url?: string): Promise<ActionResult> {
  try {
    const tabId = await cdp.openTab(url);
    return { success: true, data: { tabId } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doSwitchTab(cdp: CDPBridge, tabId: string): Promise<ActionResult> {
  try {
    await cdp.switchTab(tabId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doCloseTab(cdp: CDPBridge, tabId: string): Promise<ActionResult> {
  try {
    await cdp.closeTab(tabId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function doListTabs(cdp: CDPBridge): Promise<ActionResult> {
  try {
    const tabs = await cdp.listTabs();
    return { success: true, data: tabs };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findForm(page: SemanticPage, hint: string): SemanticForm | undefined {
  const lower = hint.toLowerCase();
  // Exact ID match
  const exact = page.forms.find((f) => f.id.toLowerCase() === lower);
  if (exact) return exact;
  // Purpose match
  const byPurpose = page.forms.find((f) => f.purpose?.toLowerCase() === lower);
  if (byPurpose) return byPurpose;
  // Partial ID match
  const partial = page.forms.find((f) => f.id.toLowerCase().includes(lower));
  if (partial) return partial;
  // Field hint match (find form containing field with this name)
  const byField = page.forms.find((f) => f.fields.some((field) => field.name.toLowerCase().includes(lower)));
  if (byField) return byField;
  return undefined;
}

function findField(form: SemanticForm, hint: string): SemanticField | undefined {
  const lower = hint.toLowerCase();
  // Name match
  const byName = form.fields.find((f) => f.name.toLowerCase() === lower);
  if (byName) return byName;
  // Label match
  const byLabel = form.fields.find((f) => f.label?.toLowerCase() === lower);
  if (byLabel) return byLabel;
  // Type match (e.g., "email" matches type="email")
  const byType = form.fields.find((f) => f.type.toLowerCase() === lower);
  if (byType) return byType;
  // Partial match
  const partial = form.fields.find((f) =>
    f.name.toLowerCase().includes(lower) ||
    f.label?.toLowerCase().includes(lower) ||
    f.placeholder?.toLowerCase().includes(lower)
  );
  return partial;
}

/**
 * Resolve a semantic field to a CDP node ID by running a query in the page.
 */
async function resolveFieldToNodeId(cdp: CDPBridge, form: SemanticForm, field: SemanticField): Promise<number | null> {
  // Build a selector strategy: try form id + field name, then field name alone
  const strategies = [
    form.id !== `form-${form.id.slice(5)}` // if id looks real
      ? `document.querySelector('#${form.id}')?.querySelector('[name="${field.name}"]')`
      : null,
    `document.querySelector('[name="${field.name}"]')`,
    `document.querySelector('input[name="${field.name}"], textarea[name="${field.name}"], select[name="${field.name}"]')`,
    field.placeholder
      ? `document.querySelector('input[placeholder*="${field.placeholder}"], textarea[placeholder*="${field.placeholder}"]')`
      : null,
    field.label
      ? `document.evaluate("//label[contains(text(), '${field.label}')]/following-sibling::*[self::input or self::textarea or self::select]", document).iterateNext()`
      : null,
  ].filter(Boolean) as string[];

  for (const strategy of strategies) {
    try {
      const result = await cdp.evaluate(`
        (function() {
          try {
            const el = ${strategy};
            return el ? { found: true, tag: el.tagName, name: el.name, id: el.id } : { found: false };
          } catch(e) {
            return { found: false, error: e.message };
          }
        })()
      `) as { found: boolean; id?: string };

      if (result?.found && result.id) {
        // We found the element, now get its nodeId via CDP DOM domain
        // First get the document root
        const doc = await cdp.getDocument();
        const nodeResult = await cdp.querySelector(doc.root.nodeId, `#${result.id}`);
        if (nodeResult?.nodeId) {
          // Set a data attribute so we can find it later via JS
          await cdp.evaluate(`
            (function() {
              const el = document.getElementById(${JSON.stringify(result.id)});
              if (el) el.setAttribute('data-cdp-nodeid', '${nodeResult.nodeId}');
            })()
          `);
          return nodeResult.nodeId;
        }
      }
    } catch {
      // Try next strategy
    }
  }

  // Fallback: try to find by generic selector
  try {
    const doc = await cdp.getDocument();
    const selectors = [
      `input[name="${field.name}"]`,
      `textarea[name="${field.name}"]`,
      `select[name="${field.name}"]`,
      `input[id="${field.name}"]`,
      `input[type="${field.type}"]`,
    ];
    for (const selector of selectors) {
      const nodeResult = await cdp.querySelector(doc.root.nodeId, selector);
      if (nodeResult?.nodeId) {
        // Set data attribute for later JS access
        await cdp.evaluate(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) el.setAttribute('data-cdp-nodeid', '${nodeResult.nodeId}');
          })()
        `);
        return nodeResult.nodeId;
      }
    }
  } catch {
    // Failed
  }

  return null;
}

/**
 * Resolve a click target (button, link, interactive element) to a CDP node ID.
 */
async function resolveClickTarget(
  cdp: CDPBridge,
  page: SemanticPage,
  hint: string,
  context?: string,
): Promise<{ nodeId: number } | null> {
  const lower = hint.toLowerCase();

  // 1. Try form actions first
  for (const form of page.forms) {
    const btn = form.actions.find((a) => a.name.toLowerCase() === lower || a.label.toLowerCase() === lower || a.action?.toLowerCase() === lower);
    if (btn) {
      // Find the button in the DOM
      const doc = await cdp.getDocument();
      const selectors = [
        `button[type="${btn.type}"]`,
        `input[type="${btn.type}"]`,
        `button:not([type])`, // <button> without type defaults to submit
        `button`,
        `input[type="submit"]`,
        `input[type="button"]`,
      ];
      for (const selector of selectors) {
        try {
          const nodeResult = await cdp.querySelector(doc.root.nodeId, selector);
          if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
        } catch {
          // Try next
        }
      }
      // Fallback: find by text content via JS
      try {
        const byText = await cdp.evaluate(`
          (function() {
            const els = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
            for (const el of els) {
              const text = (el.textContent || el.value || '').trim().toLowerCase();
              if (text === ${JSON.stringify(btn.label.toLowerCase())} || text.includes(${JSON.stringify(btn.label.toLowerCase())})) {
                return { found: true, id: el.id, tag: el.tagName, type: el.type };
              }
            }
            return { found: false };
          })()
        `) as { found: boolean; id?: string };
        if (byText?.found && byText.id) {
          const nodeResult = await cdp.querySelector(doc.root.nodeId, `#${byText.id}`);
          if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
        }
      } catch {
        // Failed
      }
    }
  }

  // 2. Try interactive elements
  const interactive = page.interactive.find((i) => i.id.toLowerCase() === lower || i.label.toLowerCase() === lower || i.type.toLowerCase() === lower);
  if (interactive?.id) {
    const doc = await cdp.getDocument();
    try {
      const nodeResult = await cdp.querySelector(doc.root.nodeId, `#${interactive.id}`);
      if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
    } catch {
      // Fallback to label text
      const byLabel = await cdp.evaluate(`
        (function() {
          const els = document.querySelectorAll('button, [role="button"], a');
          for (const el of els) {
            if (el.textContent.trim().toLowerCase() === '${interactive.label.toLowerCase().replace(/'/g, "\\'")}') {
              return { found: true, id: el.id, tag: el.tagName };
            }
          }
          return { found: false };
        })()
      `) as { found: boolean; id?: string };
      if (byLabel?.found && byLabel.id) {
        const nodeResult = await cdp.querySelector(doc.root.nodeId, `#${byLabel.id}`);
        if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
      }
    }
  }

  // 3. Try navigation links
  const link = page.navigation.find((n) => n.text.toLowerCase() === lower || n.href.toLowerCase().includes(lower));
  if (link) {
    const doc = await cdp.getDocument();
    try {
      const nodeResult = await cdp.querySelector(doc.root.nodeId, `a[href="${link.href}"]`);
      if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
    } catch {
      // Fallback: find by text
      const byText = await cdp.evaluate(`
        (function() {
          const els = document.querySelectorAll('a');
          for (const el of els) {
            if (el.textContent.trim().toLowerCase() === '${link.text.toLowerCase().replace(/'/g, "\\'")}') {
              return { found: true, id: el.id, tag: el.tagName };
            }
          }
          return { found: false };
        })()
      `) as { found: boolean; id?: string };
      if (byText?.found && byText.id) {
        const nodeResult = await cdp.querySelector(doc.root.nodeId, `#${byText.id}`);
        if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
      }
    }
  }

  // 4. Generic: find by text content anywhere
  try {
    const byText = await cdp.evaluate(`
      (function() {
        const els = document.querySelectorAll('button, [role="button"], a, input[type="submit"], input[type="button"]');
        for (const el of els) {
          const text = (el.textContent || el.value || '').trim().toLowerCase();
          if (text.includes('${lower.replace(/'/g, "\\'")}')) {
            return { found: true, id: el.id, tag: el.tagName, name: el.name };
          }
        }
        return { found: false };
      })()
    `) as { found: boolean; id?: string; name?: string };
    if (byText?.found) {
      const doc = await cdp.getDocument();
      const identifier = byText.id ? `#${byText.id}` : byText.name ? `[name="${byText.name}"]` : null;
      if (identifier) {
        const nodeResult = await cdp.querySelector(doc.root.nodeId, identifier);
        if (nodeResult?.nodeId) return { nodeId: nodeResult.nodeId };
      }
    }
  } catch {
    // Failed
  }

  return null;
}
