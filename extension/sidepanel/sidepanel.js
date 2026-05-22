let connected = false;
let recording = false;
let captureCount = 0;

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}

const iconMap = {
  navigate: { icon: '→', cls: 'navigate' },
  click:    { icon: '👆', cls: 'click' },
  fill:     { icon: '✏️', cls: 'fill' },
  record:   { icon: '⏺', cls: 'record' },
  network:  { icon: '🌐', cls: 'network' },
  agent:    { icon: '🤖', cls: 'agent' },
  page:     { icon: '📋', cls: 'navigate' },
};

function addActivity(type, main, sub) {
  const feed = document.getElementById('activity-feed');
  const empty = document.getElementById('empty-state');
  if (empty) empty.remove();

  const map = iconMap[type] || { icon: '•', cls: 'agent' };
  const item = document.createElement('div');
  item.className = 'activity-item';
  item.innerHTML = `
    <div class="activity-icon ${map.cls}">${map.icon}</div>
    <div class="activity-body">
      <div class="activity-main">${escHtml(main)}</div>
      ${sub ? `<div class="activity-sub">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="activity-time">${formatTime()}</div>
  `;
  feed.prepend(item);

  // Keep only last 50
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateStatus(isConnected) {
  connected = isConnected;
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  dot.className = `status-dot ${isConnected ? 'connected' : 'disconnected'}`;
  label.textContent = isConnected ? 'connected' : 'disconnected';
}

function toggleRecording() {
  chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING' }, (resp) => {
    if (!resp) return;
    recording = resp.recording;
    captureCount = 0;
    updateRecordingUI();

    if (!recording && resp.count > 0) {
      addActivity('record', `Recording stopped — ${resp.count} requests captured`, '');
    } else if (recording) {
      addActivity('record', 'Recording started', 'Perform your workflow in the browser');
    }
  });
}

function updateRecordingUI() {
  const btn = document.getElementById('record-btn');
  const banner = document.getElementById('recording-banner');
  if (recording) {
    btn.textContent = '⏹ Stop Recording';
    btn.classList.add('active');
    banner.classList.add('visible');
  } else {
    btn.textContent = '⏺ Record Workflow';
    btn.classList.remove('active');
    banner.classList.remove('visible');
  }
}

function capturePageNow() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_PAGE' }, (resp) => {
      if (resp?.page) {
        const formCount = resp.page.forms?.length || 0;
        const interactiveCount = resp.page.interactive?.length || 0;
        addActivity('page', resp.page.page.title || 'Page captured', `${formCount} forms, ${interactiveCount} interactive elements`);
      }
    });
  });
}

function sendIntent() {
  const input = document.getElementById('intent-input');
  const intent = input.value.trim();
  if (!intent) return;

  input.value = '';
  addActivity('agent', intent, 'Executing…');

  // Send to server via background
  chrome.runtime.sendMessage({ type: 'SEND_INTENT', intent }, (resp) => {
    if (resp?.error) {
      addActivity('agent', `Error: ${resp.error}`, '');
    }
  });
}

function handleIntentKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendIntent();
  }
}

// ── Listen for updates from background ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    updateStatus(msg.connected);
    if (msg.recording !== recording) {
      recording = msg.recording;
      updateRecordingUI();
    }
  }

  if (msg.type === 'ACTIVITY') {
    addActivity(msg.activityType, msg.main, msg.sub);
  }

  if (msg.type === 'CAPTURE_COUNT') {
    captureCount = msg.count;
    document.getElementById('capture-count').textContent = `${captureCount} requests`;
  }
});

// ── Update current page info ────────────────────────────────────────────────
function updateCurrentPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    document.getElementById('page-title').textContent = tab.title || '—';
    document.getElementById('page-url').textContent = tab.url || '';
  });
}

chrome.tabs.onActivated.addListener(updateCurrentPage);
chrome.tabs.onUpdated.addListener((_, info) => {
  if (info.status === 'complete') updateCurrentPage();
});

// Init
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
  if (resp) {
    updateStatus(resp.connected);
    recording = resp.recording;
    captureCount = resp.captured;
    updateRecordingUI();
    document.getElementById('capture-count').textContent = `${captureCount} requests`;
  }
});
updateCurrentPage();
