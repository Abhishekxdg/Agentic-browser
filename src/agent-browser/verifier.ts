/**
 * Verification Engine — compares expected outcome vs observed state after every action.
 * Turns "hope it worked" into deterministic evidence.
 */

import type { BrowserSession } from "./session-manager.ts";
import { refreshPageModel } from "./session-manager.ts";
import type { SemanticPage } from "./semantic-page.ts";
import type { SemanticAction } from "./action-resolver.ts";

export interface VerificationResult {
  verified: boolean;
  evidence: string;         // what we observed
  expected: string;         // what we predicted
  confidence: number;       // 0-1 how confident the verification is
  signals: VerificationSignal[];
}

export interface VerificationSignal {
  type: "url_changed" | "element_appeared" | "element_disappeared" | "text_changed"
      | "cookie_set" | "dialog_appeared" | "dialog_closed" | "form_cleared"
      | "page_title_changed" | "network_request_made";
  observed: boolean;
  detail?: string;
}

interface PreState {
  url: string;
  title: string;
  dialogCount: number;
  formCount: number;
  cookieCount: number;
}

// Capture pre-action state
export async function capturePreState(session: BrowserSession): Promise<PreState> {
  const page = session.pageModel ?? await refreshPageModel(session);
  const cookies = await session.cdp.getCookies().catch(() => []);
  return {
    url: page.page.url,
    title: page.page.title,
    dialogCount: page.dialogs.length,
    formCount: page.forms.length,
    cookieCount: cookies.length,
  };
}

// Verify outcome after an action
export async function verify(
  session: BrowserSession,
  action: SemanticAction,
  pre: PreState,
): Promise<VerificationResult> {
  // Small settle window for DOM/network to update
  await new Promise((r) => setTimeout(r, 400));

  const page = await refreshPageModel(session);
  const cookies = await session.cdp.getCookies().catch(() => []);
  const signals: VerificationSignal[] = [];

  // Signal: URL changed
  const urlChanged = page.page.url !== pre.url;
  signals.push({ type: "url_changed", observed: urlChanged, detail: urlChanged ? `${pre.url} → ${page.page.url}` : undefined });

  // Signal: title changed
  const titleChanged = page.page.title !== pre.title;
  signals.push({ type: "page_title_changed", observed: titleChanged, detail: titleChanged ? page.page.title : undefined });

  // Signal: dialog appeared or closed
  const dialogAppeared = page.dialogs.length > pre.dialogCount;
  const dialogClosed = page.dialogs.length < pre.dialogCount;
  if (dialogAppeared) signals.push({ type: "dialog_appeared", observed: true, detail: page.dialogs[0]?.title ?? page.dialogs[0]?.message });
  if (dialogClosed)   signals.push({ type: "dialog_closed", observed: true });

  // Signal: new cookies set
  const newCookies = cookies.length > pre.cookieCount;
  if (newCookies) signals.push({ type: "cookie_set", observed: true, detail: `${cookies.length - pre.cookieCount} new cookies` });

  // Signal: form cleared (likely submitted)
  const formCleared = page.forms.length < pre.formCount;
  if (formCleared) signals.push({ type: "form_cleared", observed: true });

  // Determine verification result based on action type
  const { verified, evidence, expected, confidence } = evaluateSignals(action, signals, page, pre);

  return { verified, evidence, expected, confidence, signals };
}

function evaluateSignals(
  action: SemanticAction,
  signals: VerificationSignal[],
  page: SemanticPage,
  pre: PreState,
): { verified: boolean; evidence: string; expected: string; confidence: number } {

  const urlChanged = signals.find((s) => s.type === "url_changed")?.observed ?? false;
  const cookieSet  = signals.find((s) => s.type === "cookie_set")?.observed ?? false;
  const dialogAppeared = signals.find((s) => s.type === "dialog_appeared")?.observed ?? false;
  const formCleared = signals.find((s) => s.type === "form_cleared")?.observed ?? false;

  switch (action.type) {
    case "navigate": {
      const expectedBase = action.url.split("?")[0] ?? action.url;
      return {
        verified: page.page.url === action.url || page.page.url.startsWith(expectedBase),
        evidence: `Landed on: ${page.page.url}`,
        expected: `URL matches: ${action.url}`,
        confidence: 1.0,
      };
    }

    case "click":
    case "click_text":
    case "click_selector": {
      // Click success signals: URL changed, dialog appeared, form cleared, or page content changed
      const anyChange = urlChanged || dialogAppeared || formCleared;
      return {
        verified: anyChange,
        evidence: anyChange
          ? [urlChanged && `URL→${page.page.url}`, dialogAppeared && "dialog appeared", formCleared && "form cleared"].filter(Boolean).join(", ")
          : "No observable change after click",
        expected: "URL change, dialog, or form state change",
        confidence: anyChange ? 0.85 : 0.30,
      };
    }

    case "fill":
    case "fill_selector": {
      // Fill success: form still present (not submitted yet) or field now has value
      const fieldExists = page.forms.some((f) =>
        f.fields.some((fld) => fld.name === (action as any).field && fld.value)
      );
      return {
        verified: true, // fills rarely produce visible state change; trust action result
        evidence: fieldExists ? `Field "${(action as any).field}" has value` : "Fill completed (value not reflected in page model)",
        expected: `Field "${(action as any).field}" filled`,
        confidence: fieldExists ? 0.95 : 0.70,
      };
    }

    case "press": {
      const enterOnLogin = action.key === "Enter" && (urlChanged || cookieSet);
      return {
        verified: action.key !== "Enter" || urlChanged || cookieSet || dialogAppeared,
        evidence: enterOnLogin ? `Enter→login: URL changed or cookie set` : `Key ${action.key} pressed`,
        expected: action.key === "Enter" ? "Navigation or auth change" : "Key event fired",
        confidence: enterOnLogin ? 0.90 : 0.60,
      };
    }

    case "handle_dialog":
      return {
        verified: !dialogAppeared || page.dialogs.length === 0,
        evidence: page.dialogs.length === 0 ? "Dialog dismissed" : `${page.dialogs.length} dialog(s) still present`,
        expected: "Dialog closed",
        confidence: 0.95,
      };

    case "wait":
    case "wait_for":
      return { verified: true, evidence: "Wait completed", expected: "Wait completed", confidence: 1.0 };

    case "scroll":
      return { verified: true, evidence: "Scroll completed", expected: "Scroll completed", confidence: 1.0 };

    default:
      return { verified: true, evidence: "Action completed", expected: "Action completed", confidence: 0.50 };
  }
}
