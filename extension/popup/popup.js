chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
  if (!resp) return;

  const serverEl = document.getElementById('server-status');
  serverEl.innerHTML = resp.connected
    ? '<span class="dot on"></span>Connected'
    : '<span class="dot off"></span>Disconnected';

  document.getElementById('rec-status').textContent = resp.recording ? '🔴 Active' : 'Off';
  document.getElementById('cap-count').textContent = `${resp.captured} requests`;

  const recBtn = document.getElementById('rec-btn');
  recBtn.textContent = resp.recording ? '⏹ Stop Recording' : '⏺ Start Recording';
});

function openSidePanel() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.sidePanel.open({ tabId: tabs[0].id });
    }
  });
  window.close();
}

function toggleRec() {
  chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING' }, () => window.close());
}
