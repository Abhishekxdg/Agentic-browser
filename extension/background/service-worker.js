/**
 * Extension Background Service Worker
 * - Maintains WebSocket connection to agent-browser server
 * - Routes agent commands to content script / chrome APIs
 * - Captures network traffic for recording
 * - Manages side panel state
 */

const DEFAULT_SERVER_URL = 'ws://localhost:3001/extension/stream';
const DEFAULT_API_KEY = 'dev-key';

let ws = null;
let wsReady = false;
let recording = false;
let capturedRequests = [];
let activeTabId = null;
let reconnectTimer = null;

// ── WebSocket connection to server ─────────────────────────────────────────
async function getConnectionConfig() {
  const stored = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  return {
    serverUrl: stored.serverUrl || DEFAULT_SERVER_URL,
    apiKey: stored.apiKey || DEFAULT_API_KEY,
  };
}

async function connect() {
  if (ws && ws.readyState < 2) return; // already connected/connecting

  const { serverUrl, apiKey } = await getConnectionConfig();
  ws = new WebSocket(`${serverUrl}?api_key=${encodeURIComponent(apiKey)}`);

  ws.onopen = () => {
    wsReady = true;
    clearTimeout(reconnectTimer);
    console.log('[agent-browser ext] connected to server');
    ws.send(JSON.stringify({ type: 'EXTENSION_HELLO' }));
    broadcastStatus();
  };

  ws.onclose = () => {
    wsReady = false;
    broadcastStatus();
    // Reconnect after 3 seconds
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    wsReady = false;
    broadcastStatus();
  };

  ws.onmessage = async (event) => {
    let cmd;
    try { cmd = JSON.parse(event.data); }
    catch { return; }
    await handleServerCommand(cmd);
  };
}

function sendToServer(msg) {
  if (ws && wsReady) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Handle commands from server ─────────────────────────────────────────────
async function handleServerCommand(cmd) {
  const { id, type } = cmd;

  let result = { success: true };

  try {
    switch (type) {
      case 'NAVIGATE': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) throw new Error('No active tab');
        await chrome.tabs.update(tabId, { url: cmd.url });
        await waitForTabLoad(tabId);
        const page = await extractPage(tabId);
        result = { success: true, page };
        break;
      }

      case 'GET_PAGE': {
        const tabId = await getActiveTabId();
        const page = await extractPage(tabId);
        result = { success: true, page };
        break;
      }

      case 'CLICK': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, {
          type: 'CLICK', target: cmd.target, selector: cmd.selector,
        });
        break;
      }

      case 'FILL': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, {
          type: 'FILL', field: cmd.field, selector: cmd.selector, value: cmd.value,
        });
        break;
      }

      case 'PRESS': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, { type: 'PRESS', key: cmd.key });
        break;
      }

      case 'SCROLL': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, {
          type: 'SCROLL', direction: cmd.direction, amount: cmd.amount,
        });
        break;
      }

      case 'EVAL': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, { type: 'EVAL', expression: cmd.expression });
        break;
      }

      case 'WAIT_FOR': {
        const tabId = await getActiveTabId();
        result = await chrome.tabs.sendMessage(tabId, {
          type: 'WAIT_FOR', selector: cmd.selector, timeoutMs: cmd.timeoutMs,
        });
        break;
      }

      case 'SCREENSHOT': {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        result = { success: true, data: dataUrl.split(',')[1] }; // base64 PNG
        break;
      }

      case 'GET_COOKIES': {
        const cookies = await chrome.cookies.getAll({ url: cmd.url || await getCurrentUrl() });
        result = { success: true, cookies: cookies.map(c => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        }))};
        break;
      }

      case 'SET_COOKIE': {
        await chrome.cookies.set({
          url: cmd.url,
          name: cmd.name,
          value: cmd.value,
          domain: cmd.domain,
          path: cmd.path || '/',
          secure: cmd.secure || false,
          httpOnly: cmd.httpOnly || false,
          sameSite: cmd.sameSite || 'lax',
          expirationDate: cmd.expirationDate,
        });
        result = { success: true };
        break;
      }

      case 'CLEAR_COOKIES': {
        const all = await chrome.cookies.getAll({ url: cmd.url || await getCurrentUrl() });
        await Promise.all(all.map(c => chrome.cookies.remove({ url: cmd.url || `https://${c.domain}${c.path}`, name: c.name })));
        result = { success: true, cleared: all.length };
        break;
      }

      case 'NEW_TAB': {
        const tab = await chrome.tabs.create({ url: cmd.url || 'about:blank' });
        activeTabId = tab.id;
        result = { success: true, tabId: tab.id };
        break;
      }

      case 'SWITCH_TAB': {
        await chrome.tabs.update(cmd.tabId, { active: true });
        activeTabId = cmd.tabId;
        result = { success: true };
        break;
      }

      case 'CLOSE_TAB': {
        await chrome.tabs.remove(cmd.tabId);
        result = { success: true };
        break;
      }

      case 'LIST_TABS': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        result = { success: true, tabs: tabs.map(t => ({
          id: t.id, url: t.url, title: t.title, active: t.active,
        }))};
        break;
      }

      case 'START_RECORDING': {
        recording = true;
        capturedRequests = [];
        broadcastStatus();
        result = { success: true, message: 'Recording started. Perform your workflow.' };
        break;
      }

      case 'STOP_RECORDING': {
        recording = false;
        const requests = [...capturedRequests];
        capturedRequests = [];
        broadcastStatus();
        result = { success: true, requests, count: requests.length };
        break;
      }

      case 'GET_STATUS': {
        const tabId = await getActiveTabId();
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        result = {
          success: true,
          connected: wsReady,
          recording,
          captured_requests: capturedRequests.length,
          active_tab: tabs[0] ? { id: tabs[0].id, url: tabs[0].url, title: tabs[0].title } : null,
        };
        break;
      }

      default:
        result = { success: false, error: `Unknown command: ${type}` };
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  // Send result back to server
  sendToServer({ type: 'COMMAND_RESULT', id, ...result });
}

// ── Helper utilities ────────────────────────────────────────────────────────
async function getActiveTabId() {
  if (activeTabId) return activeTabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

async function getCurrentUrl() {
  const tabId = await getActiveTabId();
  const tab = await chrome.tabs.get(tabId);
  return tab.url;
}

async function extractPage(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
  return response?.page;
}

async function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
      if (Date.now() - start > timeout) {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);
  });
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', connected: wsReady, recording })
    .catch(() => {}); // sidepanel may not be open
}

// ── Network capture relay ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'NETWORK_CAPTURE' && recording) {
    capturedRequests.push(msg.data);
    // Forward to server for real-time recording
    sendToServer({ type: 'NETWORK_CAPTURE', data: msg.data });
    sendResponse({ ok: true });
  }

  if (msg.type === 'CONTENT_READY') {
    sendResponse({ ok: true });
  }

  // Side panel requesting status
  if (msg.type === 'GET_STATUS') {
    sendResponse({ connected: wsReady, recording, captured: capturedRequests.length });
  }

  if (msg.type === 'TOGGLE_RECORDING') {
    if (recording) {
      recording = false;
      const requests = [...capturedRequests];
      capturedRequests = [];
      sendToServer({ type: 'RECORDING_STOPPED', requests });
      sendResponse({ recording: false, count: requests.length });
    } else {
      recording = true;
      capturedRequests = [];
      sendToServer({ type: 'RECORDING_STARTED' });
      sendResponse({ recording: true });
    }
    broadcastStatus();
  }

  return true;
});

// ── Tab events ─────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  chrome.tabs.get(info.tabId, (tab) => {
    sendToServer({ type: 'TAB_ACTIVATED', tabId: info.tabId, url: tab.url, title: tab.title });
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) {
    sendToServer({ type: 'PAGE_LOADED', tabId, url: tab.url, title: tab.title });
  }
});

// ── Side panel ─────────────────────────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Init ───────────────────────────────────────────────────────────────────
connect();
console.log('[agent-browser ext] service worker started');
