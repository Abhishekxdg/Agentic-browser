"""Python SDK client for Agent Browser — Semantic Browser for AI Agents."""

import os
import base64
from contextlib import contextmanager
from typing import Optional, Dict, Any, List, Generator
import requests


class AgentBrowserError(Exception):
    pass


class AgentBrowser:
    """
    Client for the Agent Browser semantic REST API.

    Usage:
        agent = AgentBrowser()  # uses AGENT_BROWSER_API_KEY env var, localhost:3001

        # High-level: create session, navigate, act, close
        with agent.session() as sid:
            page = agent.navigate(sid, "https://example.com")
            agent.action(sid, {"type": "fill", "form": "login", "field": "email", "value": "me@x.com"})
            agent.action(sid, {"type": "click", "target": "Sign in"})
            result = agent.get_page(sid)

        # Or manual session management
        sid = agent.create_session()
        try:
            page = agent.navigate(sid, "https://example.com")
        finally:
            agent.close_session(sid)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "http://localhost:3001",
        timeout: int = 120,
    ):
        self.api_key = api_key or os.environ.get("AGENT_BROWSER_API_KEY", "dev-key")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ── Session management ─────────────────────────────────────────────────

    def create_session(self, headless: bool = True, proxy: Optional[str] = None) -> str:
        """Create a new browser session. Returns session_id."""
        payload: Dict[str, Any] = {"headless": headless}
        if proxy:
            payload["proxy"] = proxy
        data = self._post("/session", payload)
        return data["session_id"]

    def close_session(self, session_id: str) -> None:
        """Close a browser session and release Chrome process."""
        self._delete(f"/session/{session_id}")

    @contextmanager
    def session(self, headless: bool = True) -> Generator[str, None, None]:
        """Context manager that creates a session and closes it on exit."""
        sid = self.create_session(headless=headless)
        try:
            yield sid
        finally:
            try:
                self.close_session(sid)
            except Exception:
                pass

    # ── Navigation ────────────────────────────────────────────────────────

    def navigate(self, session_id: str, url: str) -> Dict[str, Any]:
        """Navigate to URL. Returns semantic page model."""
        data = self._post(f"/session/{session_id}/navigate", {"url": url})
        return data.get("page", data)

    # ── Page inspection ───────────────────────────────────────────────────

    def get_page(self, session_id: str) -> Dict[str, Any]:
        """Get the current semantic page model (forms, links, content, interactive)."""
        data = self._get(f"/session/{session_id}/page")
        return data.get("page", data)

    # ── Actions ───────────────────────────────────────────────────────────

    def action(self, session_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a single semantic action. Returns {success, data, error, page}.

        Action types:
          navigate:        {"type": "navigate", "url": "https://..."}
          fill:            {"type": "fill", "form": "formId", "field": "fieldName", "value": "text"}
          click:           {"type": "click", "target": "Button label"}
          click_text:      {"type": "click_text", "text": "exact visible text"}
          click_selector:  {"type": "click_selector", "selector": "css selector"}
          fill_selector:   {"type": "fill_selector", "selector": "css selector", "value": "text"}
          press:           {"type": "press", "key": "Enter"}
          wait:            {"type": "wait", "condition": "network.idle", "ms": 2000}
          scroll:          {"type": "scroll", "direction": "down"}
          type_text:       {"type": "type_text", "text": "text to type"}
          screenshot:      {"type": "screenshot"}
        """
        return self._post(f"/session/{session_id}/action", action)

    def actions(self, session_id: str, actions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Execute a sequence of actions. Stops on first failure."""
        return self._post(f"/session/{session_id}/actions", {"actions": actions})

    def js(self, session_id: str, expression: str) -> Any:
        """Evaluate JavaScript in the page. Returns the result."""
        data = self._post(f"/session/{session_id}/evaluate", {"expression": expression})
        return data.get("result")

    # ── Screenshot ────────────────────────────────────────────────────────

    def screenshot(self, session_id: str, path: Optional[str] = None) -> bytes:
        """Capture screenshot. If path given, saves to file. Returns PNG bytes."""
        url = f"{self.base_url}/session/{session_id}/screenshot"
        resp = requests.get(url, headers=self._headers, timeout=self.timeout)
        resp.raise_for_status()
        png = resp.content
        if path:
            with open(path, "wb") as f:
                f.write(png)
        return png

    # ── Cookies ───────────────────────────────────────────────────────────

    def get_cookies(self, session_id: str) -> List[Dict[str, Any]]:
        data = self._get(f"/session/{session_id}/cookies")
        return data.get("cookies", [])

    def set_cookie(self, session_id: str, name: str, value: str, **kwargs: Any) -> None:
        self._post(f"/session/{session_id}/cookies", {"name": name, "value": value, **kwargs})

    def clear_cookies(self, session_id: str) -> None:
        self._delete(f"/session/{session_id}/cookies")

    # ── Tabs ──────────────────────────────────────────────────────────────

    def list_tabs(self, session_id: str) -> List[Dict[str, Any]]:
        return self._get(f"/session/{session_id}/tabs").get("tabs", [])

    def open_tab(self, session_id: str, url: Optional[str] = None) -> str:
        data = self._post(f"/session/{session_id}/tabs", {"url": url} if url else {})
        return data["tab_id"]

    def switch_tab(self, session_id: str, tab_id: str) -> None:
        self._put(f"/session/{session_id}/tabs/{tab_id}")

    # ── Misc ──────────────────────────────────────────────────────────────

    def health(self) -> Dict[str, Any]:
        return self._get("/health")

    def list_sessions(self) -> List[Dict[str, Any]]:
        return self._get("/session").get("sessions", [])

    # ── HTTP helpers ──────────────────────────────────────────────────────

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        resp = requests.post(
            f"{self.base_url}{path}",
            json=payload,
            headers=self._headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def _get(self, path: str) -> Dict[str, Any]:
        resp = requests.get(
            f"{self.base_url}{path}",
            headers=self._headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def _delete(self, path: str) -> Dict[str, Any]:
        resp = requests.delete(
            f"{self.base_url}{path}",
            headers=self._headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def _put(self, path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        resp = requests.put(
            f"{self.base_url}{path}",
            json=payload or {},
            headers=self._headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()
