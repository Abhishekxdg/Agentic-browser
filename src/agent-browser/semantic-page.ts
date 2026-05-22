/**
 * Semantic Page Model (SPM)
 * Converts raw DOM into structured JSON that LLMs can understand natively.
 * No CSS selectors, no coordinates — just meaning.
 */

import type { CDPBridge } from "./cdp-bridge.ts";

export interface SemanticPage {
  page: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
  };
  forms: SemanticForm[];
  navigation: SemanticLink[];
  content: SemanticContentBlock[];
  interactive: SemanticInteractive[];
  tables: SemanticTable[];
  lists: SemanticList[];
  search: SemanticSearch | null;
  media: SemanticMedia[];
  dialogs: SemanticDialog[];
  iframes: SemanticIframe[];
}

export interface SemanticDialog {
  type: "modal" | "alert" | "confirm" | "prompt" | "drawer" | "tooltip";
  title?: string;
  message?: string;
  actions: string[];
}

export interface SemanticIframe {
  src: string;
  title?: string;
  forms: SemanticForm[];
  content: SemanticContentBlock[];
  interactive: SemanticInteractive[];
}

export interface SemanticForm {
  id: string;
  purpose?: string; // "authentication", "search", "contact", "payment", etc.
  action?: string;
  method?: string;
  fields: SemanticField[];
  actions: SemanticButton[];
}

export interface SemanticField {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  value?: string | number | boolean;
  options?: string[]; // for select/radio
}

export interface SemanticButton {
  name: string;
  type: "submit" | "button" | "reset";
  label: string;
  action?: string; // inferred purpose like "login", "search", "cancel"
}

export interface SemanticLink {
  text: string;
  href: string;
  type: "link" | "button-link";
  external?: boolean;
}

export interface SemanticContentBlock {
  type: "heading" | "paragraph" | "blockquote" | "code" | "preformatted";
  level?: number; // for headings
  text: string;
}

export interface SemanticInteractive {
  id: string;
  type: "button" | "toggle" | "tab" | "accordion" | "dropdown" | "slider" | "date-picker";
  label: string;
  state?: "on" | "off" | "open" | "closed";
}

export interface SemanticTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface SemanticList {
  id: string;
  type: "ordered" | "unordered";
  items: string[];
}

export interface SemanticSearch {
  fieldName: string;
  placeholder?: string;
  hasSubmit: boolean;
}

export interface SemanticMedia {
  type: "image" | "video" | "audio";
  alt?: string;
  src?: string;
}

export interface SemanticExtractionOptions {
  mode?: "full" | "fast" | "auto";
}

/**
 * Extract a semantic page model from the current CDP page.
 * This runs a single JavaScript evaluation in the page context for speed.
 */
function sanitizeStrings(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Strip all control chars except tab (\x09), newline (\x0a), carriage return (\x0d)
    return obj.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").replace(/\\u[0-9a-fA-F]{0,3}[\x00-\x1f\x7f-\x9f]/g, "");
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeStrings);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeStrings(value);
    }
    return result;
  }
  return obj;
}

export async function extractSemanticPage(cdp: CDPBridge, options: SemanticExtractionOptions = {}): Promise<SemanticPage> {
  if (options.mode === "fast" || options.mode === "auto") {
    const rawModel = sanitizeStrings(await cdp.evaluate(FAST_EXTRACTION_SCRIPT)) as Record<string, unknown>;
    const page = rawModel.page as SemanticPage["page"] | undefined;
    const fastModel = {
      page: page ?? { url: "", title: "", viewport: { width: 0, height: 0 } },
      forms: (rawModel.forms as SemanticForm[]) ?? [],
      navigation: (rawModel.navigation as SemanticLink[]) ?? [],
      content: (rawModel.content as SemanticContentBlock[]) ?? [],
      interactive: (rawModel.interactive as SemanticInteractive[]) ?? [],
      tables: [],
      lists: [],
      search: (rawModel.search as SemanticSearch | null) ?? null,
      media: [],
      dialogs: [],
      iframes: [],
    };
    if (options.mode === "fast" || hasUsefulFastModel(fastModel)) return fastModel;
  }

  const [url, title, viewport] = await Promise.all([
    cdp.getUrl(),
    cdp.getTitle(),
    cdp.evaluate("({ width: window.innerWidth, height: window.innerHeight })") as Promise<{ width: number; height: number }>,
  ]);

  const rawModel = sanitizeStrings(await cdp.evaluate(EXTRACTION_SCRIPT)) as Record<string, unknown>;

  return {
    page: { url, title, viewport },
    forms: (rawModel.forms as SemanticForm[]) ?? [],
    navigation: (rawModel.navigation as SemanticLink[]) ?? [],
    content: (rawModel.content as SemanticContentBlock[]) ?? [],
    interactive: (rawModel.interactive as SemanticInteractive[]) ?? [],
    tables: (rawModel.tables as SemanticTable[]) ?? [],
    lists: (rawModel.lists as SemanticList[]) ?? [],
    search: (rawModel.search as SemanticSearch | null) ?? null,
    media: (rawModel.media as SemanticMedia[]) ?? [],
    dialogs: (rawModel.dialogs as SemanticDialog[]) ?? [],
    iframes: (rawModel.iframes as SemanticIframe[]) ?? [],
  };
}

function hasUsefulFastModel(model: SemanticPage): boolean {
  if (!model.page.title && !model.page.url) return false;
  return Boolean(
    model.forms.length ||
    model.navigation.length ||
    model.content.length ||
    model.interactive.length ||
    model.search,
  );
}

const FAST_EXTRACTION_SCRIPT = `
(function() {
  function text(el, max = 160) {
    return (el.textContent || "").replace(/[\\x00-\\x08\\x0b-\\x0c\\x0e-\\x1f]/g, "").trim().slice(0, max);
  }
  function label(el) {
    const id = el.id;
    if (id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lbl) return text(lbl);
    }
    const parent = el.closest('label');
    return (parent && text(parent)) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  }
  function buttonAction(el) {
    const t = text(el).toLowerCase();
    if (t.includes('login') || t.includes('sign in')) return 'login';
    if (t.includes('search') || t.includes('find')) return 'search';
    if (t.includes('submit') || t.includes('send')) return 'submit';
    if (t.includes('next') || t.includes('continue')) return 'next';
    return undefined;
  }
  const forms = Array.from(document.querySelectorAll('form')).slice(0, 16).map((form, i) => {
    const fields = Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select')).slice(0, 80).map((input) => {
      const tag = input.tagName.toLowerCase();
      return {
        name: input.getAttribute('name') || input.id || '',
        type: input.getAttribute('type') || (tag === 'select' ? 'select' : 'text'),
        label: label(input) || undefined,
        placeholder: input.getAttribute('placeholder') || undefined,
        required: input.required || undefined,
        value: input.value || undefined,
      };
    });
    const actions = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="reset"]')).slice(0, 24).map((btn) => {
      const type = btn.getAttribute('type') || (btn.tagName.toLowerCase() === 'button' ? 'submit' : 'button');
      return {
        name: btn.getAttribute('name') || btn.id || text(btn) || 'button',
        type: type === 'reset' ? 'reset' : type === 'button' ? 'button' : 'submit',
        label: text(btn) || btn.getAttribute('value') || '',
        action: buttonAction(btn),
      };
    });
    return {
      id: form.id || form.getAttribute('name') || 'form-' + i,
      action: form.getAttribute('action') || undefined,
      method: form.getAttribute('method') || undefined,
      fields,
      actions,
    };
  });
  const navigation = Array.from(document.querySelectorAll('a[href]')).slice(0, 120).map((a) => ({
    text: text(a),
    href: a.href,
    type: (a.getAttribute('role') === 'button' ? 'button-link' : 'link'),
    external: a.hostname !== location.hostname || undefined,
  })).filter((a) => a.text || a.href);
  const content = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 40).map((h) => ({
    type: 'heading',
    level: Number(h.tagName.slice(1)),
    text: text(h, 240),
  })).filter((h) => h.text);
  const interactive = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], summary')).slice(0, 100).map((el, i) => ({
    id: el.id || el.getAttribute('name') || 'interactive-' + i,
    type: el.getAttribute('role') === 'tab' ? 'tab' : 'button',
    label: text(el) || el.getAttribute('aria-label') || '',
  })).filter((el) => el.label);
  const searchEl = document.querySelector('input[type="search"], input[name="q"], input[name="search"], input[placeholder*="Search" i], textarea[name="q"]');
  return {
    page: {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
    },
    forms,
    navigation,
    content,
    interactive,
    search: searchEl ? {
      fieldName: searchEl.getAttribute('name') || searchEl.id || '',
      placeholder: searchEl.getAttribute('placeholder') || undefined,
      hasSubmit: Boolean(searchEl.closest('form')?.querySelector('button, input[type="submit"]')),
    } : null,
  };
})()
`;

const EXTRACTION_SCRIPT = `
(function() {
  function getText(el) {
    return (el.textContent || "").replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, "").trim().slice(0, 200);
  }

  // Recursively collect all elements including shadow DOM
  function allElements(root, selector) {
    const results = Array.from(root.querySelectorAll(selector));
    const hosts = root.querySelectorAll('*');
    for (const host of hosts) {
      if (host.shadowRoot) {
        results.push(...allElements(host.shadowRoot, selector));
      }
    }
    return results;
  }

  function getLabel(el) {
    const id = el.id;
    if (id) {
      const lbl = document.querySelector('label[for="' + id + '"]');
      if (lbl) return getText(lbl);
    }
    const parent = el.closest('label');
    if (parent) return getText(parent);
    return el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  }

  function inferPurpose(form) {
    const html = form.outerHTML.toLowerCase();
    if (html.includes('login') || html.includes('signin') || html.includes('auth')) return 'authentication';
    if (html.includes('search') || html.includes('query')) return 'search';
    if (html.includes('contact') || html.includes('message')) return 'contact';
    if (html.includes('payment') || html.includes('card') || html.includes('checkout')) return 'payment';
    if (html.includes('subscribe') || html.includes('newsletter')) return 'subscription';
    if (html.includes('register') || html.includes('signup')) return 'registration';
    return undefined;
  }

  function inferButtonAction(btn) {
    const text = getText(btn).toLowerCase();
    if (text.includes('login') || text.includes('sign in')) return 'login';
    if (text.includes('search') || text.includes('find')) return 'search';
    if (text.includes('submit') || text.includes('send')) return 'submit';
    if (text.includes('cancel') || text.includes('close')) return 'cancel';
    if (text.includes('next') || text.includes('continue')) return 'next';
    if (text.includes('back') || text.includes('previous')) return 'previous';
    if (text.includes('delete') || text.includes('remove')) return 'delete';
    return undefined;
  }

  // --- Forms ---
  const forms = [];
  for (const form of allElements(document, 'form')) {
    const fields = [];
    for (const input of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      const tag = input.tagName.toLowerCase();
      const type = input.getAttribute('type') || (tag === 'select' ? 'select' : 'text');
      const name = input.getAttribute('name') || input.id || '';
      const label = getLabel(input);
      const field = {
        name,
        type,
        label: label || undefined,
        placeholder: input.getAttribute('placeholder') || undefined,
        required: input.required || undefined,
        value: input.value || undefined,
      };
      if (tag === 'select') {
        field.options = Array.from(input.querySelectorAll('option')).map(o => o.textContent.trim());
      }
      if (type === 'radio') {
        // Group radios by name
        const existing = fields.find(f => f.name === name && f.type === 'radio');
        if (existing) {
          if (!existing.options) existing.options = [];
          existing.options.push(input.value || getText(input));
        } else {
          field.options = [input.value || getText(input)];
          fields.push(field);
        }
        continue;
      }
      fields.push(field);
    }

    const buttons = [];
    for (const btn of form.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="reset"]')) {
      const tag = btn.tagName.toLowerCase();
      const type = btn.getAttribute('type') || (tag === 'button' ? 'submit' : 'button');
      buttons.push({
        name: btn.getAttribute('name') || btn.id || getText(btn) || 'button',
        type: type === 'submit' ? 'submit' : type === 'reset' ? 'reset' : 'button',
        label: getText(btn) || btn.getAttribute('value') || '',
        action: inferButtonAction(btn),
      });
    }

    forms.push({
      id: form.id || 'form-' + Math.random().toString(36).slice(2, 8),
      purpose: inferPurpose(form),
      action: form.getAttribute('action') || undefined,
      method: form.getAttribute('method') || undefined,
      fields,
      actions: buttons,
    });
  }

  // Also detect isolated inputs not in a form (common in SPAs)
  const standaloneInputs = allElements(document, 'input:not([type="hidden"]):not(form input), textarea:not(form textarea), select:not(form select)');
  if (standaloneInputs.length > 0) {
    const fields = [];
    for (const input of standaloneInputs) {
      const tag = input.tagName.toLowerCase();
      const type = input.getAttribute('type') || (tag === 'select' ? 'select' : 'text');
      const name = input.getAttribute('name') || input.id || '';
      fields.push({
        name,
        type,
        label: getLabel(input) || undefined,
        placeholder: input.getAttribute('placeholder') || undefined,
        required: input.required || undefined,
        value: input.value || undefined,
      });
    }
    // Group into a pseudo-form
    forms.push({
      id: 'standalone-' + Math.random().toString(36).slice(2, 8),
      purpose: undefined,
      fields,
      actions: [],
    });
  }

  // --- Navigation ---
  const navigation = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('javascript:') || href === '#') continue;
    navigation.push({
      text: getText(a),
      href: href,
      type: 'link',
      external: href.startsWith('http') && !href.includes(window.location.host),
    });
  }
  // Also capture button-like navigation
  for (const btn of document.querySelectorAll('[role="link"], [onclick]')) {
    if (btn.tagName.toLowerCase() === 'a') continue;
    const onclick = btn.getAttribute('onclick') || '';
    const hrefMatch = onclick.match(/window\\.location\\.href\\s*=\\s*['"]([^'"]+)['"]/);
    if (hrefMatch) {
      navigation.push({
        text: getText(btn),
        href: hrefMatch[1],
        type: 'button-link',
      });
    }
  }

  // --- Content ---
  const content = [];
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, pre, code')) {
    const tag = el.tagName.toLowerCase();
    if (tag.startsWith('h')) {
      content.push({ type: 'heading', level: parseInt(tag[1]), text: getText(el) });
    } else if (tag === 'p') {
      const text = getText(el);
      if (text.length > 0) content.push({ type: 'paragraph', text });
    } else if (tag === 'blockquote') {
      content.push({ type: 'blockquote', text: getText(el) });
    } else if (tag === 'pre' || tag === 'code') {
      content.push({ type: 'preformatted', text: getText(el) });
    }
  }

  // --- Interactive ---
  const interactive = [];
  for (const el of allElements(document, 'button:not(form button), [role="button"]:not(form [role="button"]), [role="tab"], [role="switch"], [role="slider"]')) {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    let type = 'button';
    if (role === 'tab') type = 'tab';
    else if (role === 'switch') type = 'toggle';
    else if (role === 'slider') type = 'slider';
    else if (el.closest('[role="tablist"]')) type = 'tab';
    else if (el.getAttribute('aria-expanded') !== null) type = 'accordion';
    else if (el.getAttribute('aria-haspopup') === 'true' || el.getAttribute('aria-haspopup') === 'listbox') type = 'dropdown';

    let state;
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') state = 'open';
    else if (expanded === 'false') state = 'closed';
    const checked = el.getAttribute('aria-checked');
    if (checked === 'true') state = 'on';
    else if (checked === 'false') state = 'off';

    interactive.push({
      id: el.id || el.getAttribute('name') || 'btn-' + Math.random().toString(36).slice(2, 8),
      type,
      label: getLabel(el) || getText(el),
      state,
    });
  }

  // --- Tables ---
  const tables = [];
  for (const table of document.querySelectorAll('table')) {
    const caption = table.querySelector('caption');
    const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th')).map(th => getText(th));
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr, tr:not(:first-child)')) {
      if (tr.querySelector('th')) continue; // skip header rows
      const cells = Array.from(tr.querySelectorAll('td')).map(td => getText(td));
      if (cells.length > 0) rows.push(cells);
    }
    tables.push({
      id: table.id || 'table-' + Math.random().toString(36).slice(2, 8),
      caption: caption ? getText(caption) : undefined,
      headers,
      rows,
    });
  }

  // --- Lists ---
  const lists = [];
  for (const list of document.querySelectorAll('ul, ol')) {
    lists.push({
      id: list.id || 'list-' + Math.random().toString(36).slice(2, 8),
      type: list.tagName.toLowerCase() === 'ul' ? 'unordered' : 'ordered',
      items: Array.from(list.querySelectorAll('li')).map(li => getText(li)),
    });
  }

  // --- Search ---
  let search = null;
  const searchInput = document.querySelector('input[type="search"], [role="searchbox"], input[name="q"], input[name="search"], textarea[name="q"], textarea[name="search"]');
  if (searchInput) {
    const form = searchInput.closest('form');
    const hasSubmit = form ? form.querySelector('button[type="submit"], input[type="submit"]') !== null : false;
    search = {
      fieldName: searchInput.getAttribute('name') || searchInput.id || 'search',
      placeholder: searchInput.getAttribute('placeholder') || undefined,
      hasSubmit,
    };
  }

  // --- Media ---
  const media = [];
  for (const img of document.querySelectorAll('img')) {
    media.push({ type: 'image', alt: img.getAttribute('alt') || undefined, src: img.getAttribute('src') || undefined });
  }
  for (const vid of document.querySelectorAll('video')) {
    media.push({ type: 'video', src: vid.getAttribute('src') || vid.querySelector('source')?.getAttribute('src') || undefined });
  }
  for (const aud of document.querySelectorAll('audio')) {
    media.push({ type: 'audio', src: aud.getAttribute('src') || aud.querySelector('source')?.getAttribute('src') || undefined });
  }

  // --- Dialogs / Modals ---
  const dialogs = [];
  const modalSelectors = [
    '[role="dialog"]', '[role="alertdialog"]',
    '.modal', '.dialog', '.drawer', '.sheet',
    '[aria-modal="true"]',
  ];
  for (const selector of modalSelectors) {
    for (const el of document.querySelectorAll(selector)) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const role = el.getAttribute('role') || 'modal';
      const type = role === 'alertdialog' ? 'alert' : 'modal';
      const title = el.querySelector('[role="heading"], h1, h2, h3, .modal-title, .dialog-title');
      const message = el.querySelector('p, .modal-body, .dialog-body, [role="document"]');
      const actionEls = el.querySelectorAll('button, [role="button"], input[type="submit"]');
      dialogs.push({
        type,
        title: title ? getText(title) : undefined,
        message: message ? getText(message) : undefined,
        actions: Array.from(actionEls).map(a => getText(a)).filter(Boolean),
      });
    }
  }

  // --- Iframes ---
  const iframes = [];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const doc = iframe.contentDocument;
      if (!doc) { iframes.push({ src: iframe.src || '', title: iframe.title || undefined, forms: [], content: [], interactive: [] }); continue; }
      const iframeForms = [];
      for (const form of doc.querySelectorAll('form')) {
        const fields = [];
        for (const input of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
          const type = input.getAttribute('type') || (input.tagName.toLowerCase() === 'select' ? 'select' : 'text');
          fields.push({ name: input.getAttribute('name') || input.id || '', type, placeholder: input.getAttribute('placeholder') || undefined, value: input.value || undefined });
        }
        iframeForms.push({ id: form.id || 'iframe-form', fields, actions: [] });
      }
      const iframeContent = [];
      for (const el of doc.querySelectorAll('h1,h2,h3,p')) {
        const text = (el.textContent || '').trim().slice(0, 200);
        if (text) iframeContent.push({ type: el.tagName.toLowerCase().startsWith('h') ? 'heading' : 'paragraph', text });
      }
      const iframeInteractive = [];
      for (const btn of doc.querySelectorAll('button, [role="button"]')) {
        const text = (btn.textContent || '').trim();
        if (text) iframeInteractive.push({ id: btn.id || 'ibtn', type: 'button', label: text });
      }
      iframes.push({ src: iframe.src || '', title: iframe.title || undefined, forms: iframeForms, content: iframeContent, interactive: iframeInteractive });
    } catch {
      iframes.push({ src: iframe.src || '', title: iframe.title || undefined, forms: [], content: [], interactive: [] });
    }
  }

  return { forms, navigation, content, interactive, tables, lists, search, media, dialogs, iframes };
})()
`;
