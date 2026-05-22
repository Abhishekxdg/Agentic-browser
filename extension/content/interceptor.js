/**
 * Network Interceptor — injected into page context to capture fetch/XHR.
 * Runs as a real page script (not content script) to intercept before page code.
 * Sends captured requests to content script via window.postMessage.
 */
(function () {
  if (window.__agentBrowserInterceptorInstalled) return;
  window.__agentBrowserInterceptorInstalled = true;

  const SKIP_EXTS = new Set(['.js','.css','.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2','.ttf','.map','.webp']);

  function shouldCapture(url, method) {
    try {
      const u = new URL(url);
      const ext = '.' + (u.pathname.split('.').pop() || '').toLowerCase();
      if (SKIP_EXTS.has(ext)) return false;
      if (method.toUpperCase() !== 'GET') return true;
      return u.pathname.includes('/api/') || u.pathname.includes('/v1/') || u.pathname.includes('/v2/') || u.pathname.includes('/graphql');
    } catch { return false; }
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/');
      const normalized = parts.map(p => {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p)) return ':param';
        if (/^\d+$/.test(p) && p.length > 2) return ':param';
        if (/^[a-z0-9]{20,}$/i.test(p)) return ':param';
        return p;
      }).join('/');
      return u.origin + normalized;
    } catch { return url; }
  }

  // ── Intercept fetch ─────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input !== 'string' ? input.method : null) || 'GET').toUpperCase();

    if (!shouldCapture(url, method)) return origFetch.apply(this, arguments);

    let reqBody = null;
    try { reqBody = JSON.parse(init.body); } catch { reqBody = init.body || null; }

    const response = await origFetch.apply(this, arguments);
    const cloned = response.clone();

    let resBody = null;
    try { resBody = await cloned.json(); } catch {}

    window.postMessage({
      __agentBrowserCapture: true,
      method, url,
      urlTemplate: normalizeUrl(url),
      requestBody: reqBody,
      responseStatus: response.status,
      responseBody: resBody,
      timestamp: Date.now(),
    }, '*');

    return response;
  };

  // ── Intercept XHR ───────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__agentMethod = method;
    this.__agentUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const method = (this.__agentMethod || 'GET').toUpperCase();
    const url = this.__agentUrl || '';
    if (shouldCapture(url, method)) {
      let reqBody = null;
      try { reqBody = JSON.parse(body); } catch { reqBody = body || null; }

      this.addEventListener('load', () => {
        let resBody = null;
        try { resBody = JSON.parse(this.responseText); } catch {}
        window.postMessage({
          __agentBrowserCapture: true,
          method, url,
          urlTemplate: normalizeUrl(url),
          requestBody: reqBody,
          responseStatus: this.status,
          responseBody: resBody,
          timestamp: Date.now(),
        }, '*');
      });
    }
    return origSend.apply(this, arguments);
  };
})();
