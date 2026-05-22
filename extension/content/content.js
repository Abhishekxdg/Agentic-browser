/**
 * Content Script — runs in every page.
 * Extracts semantic page model, executes agent actions, relays network captures.
 */

// ── Inject network interceptor ─────────────────────────────────────────────
(function injectInterceptor() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('content/interceptor.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

// Relay interceptor captures to background
window.addEventListener('message', (e) => {
  if (e.data?.__agentBrowserCapture) {
    chrome.runtime.sendMessage({ type: 'NETWORK_CAPTURE', data: e.data });
  }
});

// ── Semantic page model extraction ─────────────────────────────────────────
function extractPageModel() {
  const forms = extractForms();
  const interactive = extractInteractive();
  const navigation = extractNavigation();
  const content = extractContent();
  const tables = extractTables();
  const dialogs = extractDialogs();

  return {
    page: {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    forms, interactive, navigation, content, tables, dialogs,
  };
}

function extractForms() {
  const forms = [];
  document.querySelectorAll('form').forEach((form, i) => {
    const fields = [];
    form.querySelectorAll('input, textarea, select').forEach(el => {
      if (el.type === 'hidden' || el.type === 'submit') return;
      fields.push({
        name: el.name || el.id || el.getAttribute('aria-label') || `field_${fields.length}`,
        type: el.type || el.tagName.toLowerCase(),
        label: getLabel(el),
        placeholder: el.placeholder || null,
        required: el.required || false,
        value: el.value || null,
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).map(o => o.text)
          : null,
      });
    });
    const actions = [];
    form.querySelectorAll('button, input[type=submit]').forEach(btn => {
      actions.push({ label: btn.textContent?.trim() || btn.value || 'Submit', type: btn.type || 'button' });
    });
    forms.push({
      id: form.id || form.name || `form_${i}`,
      purpose: inferFormPurpose(form),
      action: form.action || null,
      method: form.method || 'get',
      fields,
      actions,
    });
  });
  return forms;
}

function getLabel(el) {
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.textContent?.trim();
  }
  const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
  if (ariaLabel) {
    const el2 = document.getElementById(ariaLabel);
    return el2 ? el2.textContent?.trim() : ariaLabel;
  }
  const parent = el.closest('label');
  if (parent) return parent.textContent?.trim()?.replace(el.value, '').trim();
  return el.placeholder || el.name || null;
}

function inferFormPurpose(form) {
  const html = form.innerHTML.toLowerCase();
  if (html.includes('password') || html.includes('signin') || html.includes('login')) return 'authentication';
  if (html.includes('search')) return 'search';
  if (html.includes('email') && html.includes('message')) return 'contact';
  if (html.includes('card') || html.includes('payment')) return 'payment';
  if (html.includes('register') || html.includes('signup')) return 'registration';
  return null;
}

function extractInteractive() {
  const els = [];
  const seen = new Set();
  document.querySelectorAll('button, [role="button"], [role="tab"], [role="switch"], details > summary').forEach(el => {
    const label = el.textContent?.trim() || el.getAttribute('aria-label') || '';
    if (!label || seen.has(label)) return;
    seen.add(label);
    if (el.offsetParent === null) return;
    const id = el.id || el.getAttribute('data-id') || `btn_${els.length}`;
    let type = 'button';
    if (el.getAttribute('role') === 'tab') type = 'tab';
    if (el.getAttribute('role') === 'switch') type = 'toggle';
    if (el.tagName === 'SUMMARY') type = 'accordion';
    const state = el.getAttribute('aria-expanded') || el.getAttribute('aria-checked') || null;
    els.push({ id, type, label, state });
  });
  return els;
}

function extractNavigation() {
  const links = [];
  const seen = new Set();
  document.querySelectorAll('nav a, header a, [role="navigation"] a').forEach(a => {
    const text = a.textContent?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    links.push({
      text,
      href: a.href,
      type: a.querySelector('button') ? 'button-link' : 'link',
      external: a.hostname !== location.hostname,
    });
  });
  return links;
}

function extractContent() {
  const blocks = [];
  document.querySelectorAll('h1,h2,h3,h4,p,blockquote,pre').forEach(el => {
    const text = el.textContent?.trim();
    if (!text || text.length < 3) return;
    const type = el.tagName.toLowerCase();
    const isHeading = /^h[1-6]$/.test(type);
    blocks.push({
      type: isHeading ? 'heading' : type === 'p' ? 'paragraph' : type,
      level: isHeading ? parseInt(type[1]) : undefined,
      text: text.slice(0, 500),
    });
    if (blocks.length >= 20) return;
  });
  return blocks;
}

function extractTables() {
  const tables = [];
  document.querySelectorAll('table').forEach((table, i) => {
    const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim());
    const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 20).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim())
    );
    if (headers.length || rows.length) {
      tables.push({ id: table.id || `table_${i}`, headers, rows });
    }
  });
  return tables;
}

function extractDialogs() {
  const dialogs = [];
  document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog').forEach(el => {
    if (el.offsetParent === null && !(el instanceof HTMLDialogElement && el.open)) return;
    const title = el.querySelector('[role="heading"], h1, h2, h3')?.textContent?.trim();
    const message = el.querySelector('p, [role="document"]')?.textContent?.trim();
    const actions = Array.from(el.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean);
    dialogs.push({ type: 'modal', title, message, actions });
  });
  return dialogs;
}

// ── Element resolution for actions ─────────────────────────────────────────
function findElement(hint) {
  // By id
  let el = document.getElementById(hint);
  if (el) return el;
  // By name
  el = document.querySelector(`[name="${hint}"]`);
  if (el) return el;
  // By aria-label
  el = document.querySelector(`[aria-label="${hint}"]`);
  if (el) return el;
  // By placeholder
  el = document.querySelector(`[placeholder="${hint}"]`);
  if (el) return el;
  // By visible text (buttons, links)
  const all = document.querySelectorAll('button, a, [role="button"], label, span, div');
  for (const node of all) {
    if (node.textContent?.trim() === hint && node.offsetParent !== null) return node;
  }
  // Partial text match
  for (const node of all) {
    if (node.textContent?.trim().toLowerCase().includes(hint.toLowerCase()) && node.offsetParent !== null) return node;
  }
  return null;
}

function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
  if (el.click) el.click();
}

function simulateFill(el, value) {
  el.focus();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) nativeInputValueSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Message handler from background ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'EXTRACT_PAGE': {
      sendResponse({ success: true, page: extractPageModel() });
      break;
    }

    case 'CLICK': {
      const el = msg.selector
        ? document.querySelector(msg.selector)
        : findElement(msg.target);
      if (!el) { sendResponse({ success: false, error: `Element not found: ${msg.target || msg.selector}` }); break; }
      simulateClick(el);
      sendResponse({ success: true });
      break;
    }

    case 'FILL': {
      const el = msg.selector
        ? document.querySelector(msg.selector)
        : (document.querySelector(`[name="${msg.field}"]`) || findElement(msg.field));
      if (!el) { sendResponse({ success: false, error: `Field not found: ${msg.field || msg.selector}` }); break; }
      simulateFill(el, String(msg.value));
      sendResponse({ success: true });
      break;
    }

    case 'PRESS': {
      const active = document.activeElement || document.body;
      active.dispatchEvent(new KeyboardEvent('keydown', { key: msg.key, bubbles: true, cancelable: true }));
      active.dispatchEvent(new KeyboardEvent('keyup',   { key: msg.key, bubbles: true }));
      if (msg.key === 'Enter') {
        const form = active.closest('form');
        if (form) form.submit();
      }
      sendResponse({ success: true });
      break;
    }

    case 'SCROLL': {
      const amount = msg.amount || 400;
      if (msg.direction === 'top') window.scrollTo(0, 0);
      else if (msg.direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else if (msg.direction === 'down') window.scrollBy(0, amount);
      else window.scrollBy(0, -amount);
      sendResponse({ success: true });
      break;
    }

    case 'EVAL': {
      if (msg.allowEval !== true) {
        sendResponse({ success: false, error: 'EVAL disabled' });
        break;
      }
      try {
        const result = eval(msg.expression);
        sendResponse({ success: true, result: result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      break;
    }

    case 'WAIT_FOR': {
      const selector = msg.selector;
      const timeout = msg.timeoutMs || 15000;
      const start = Date.now();
      const check = setInterval(() => {
        if (document.querySelector(selector)) {
          clearInterval(check);
          sendResponse({ success: true });
        } else if (Date.now() - start > timeout) {
          clearInterval(check);
          sendResponse({ success: false, error: `Timeout waiting for: ${selector}` });
        }
      }, 200);
      return true; // async response
    }

    case 'GET_TEXT': {
      const el = document.querySelector(msg.selector);
      sendResponse({ success: !!el, text: el?.textContent?.trim() });
      break;
    }
  }
  return true;
});

// Report ready to background
chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href, title: document.title });
