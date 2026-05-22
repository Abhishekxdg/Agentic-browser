"""
Sound Browser Native SDK (Python)
Interact with the semantic browser via its REST API.
The agent never sees a CSS selector — only structured page data.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

import requests


@dataclass
class SemanticBrowser:
    """Client for the semantic agent browser.
    The agent controls the browser via structured actions and receives
    structured page data — no CSS selectors, no screenshots.
    """

    base_url: str = "http://localhost:3001"
    api_key: str = ""
    session_id: str | None = None

    def __post_init__(self):
        if not self.api_key:
            self.api_key = os.environ.get("SOUND_BROWSER_API_KEY") or os.environ.get("AGENT_BROWSER_API_KEY", "dev-key")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _req(self, method: str, path: str, json_data: dict | None = None) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        resp = requests.request(method, url, headers=self._headers(), json=json_data or {}, timeout=60)
        resp.raise_for_status()
        return resp.json()

    # ── Session lifecycle ───────────────────────────────────

    def create_session(self, headless: bool = True, proxy: str | None = None) -> str:
        """Create a new browser session and return its ID."""
        data = {"headless": headless}
        if proxy:
            data["proxy"] = proxy
        result = self._req("POST", "/session", data)
        self.session_id = result["session_id"]
        return self.session_id

    def close(self) -> bool:
        """Close the current session."""
        if not self.session_id:
            return False
        self._req("DELETE", f"/session/{self.session_id}")
        self.session_id = None
        return True

    # ── Navigation ──────────────────────────────────────────

    def navigate(self, url: str) -> dict[str, Any]:
        """Navigate to a URL and return the semantic page model."""
        return self._req("POST", f"/session/{self.session_id}/navigate", {"url": url})

    def get_page(self) -> dict[str, Any]:
        """Get the current semantic page model."""
        return self._req("GET", f"/session/{self.session_id}/page")

    # ── Semantic Actions ────────────────────────────────────

    def fill(self, form: str, field: str, value: str | int | bool) -> dict[str, Any]:
        """Fill a form field."""
        return self.action({"type": "fill", "form": form, "field": field, "value": value})

    def click(self, target: str, context: str | None = None) -> dict[str, Any]:
        """Click an element by semantic name."""
        action: dict[str, Any] = {"type": "click", "target": target}
        if context:
            action["context"] = context
        return self.action(action)

    def select(self, form: str, field: str, option: str) -> dict[str, Any]:
        """Select an option from a dropdown."""
        return self.action({"type": "select", "form": form, "field": field, "option": option})

    def scroll(self, direction: str = "down", amount: int | None = None) -> dict[str, Any]:
        """Scroll the page."""
        action: dict[str, Any] = {"type": "scroll", "direction": direction}
        if amount is not None:
            action["amount"] = amount
        return self.action(action)

    def wait(self, condition: str = "time", ms: int = 1000) -> dict[str, Any]:
        """Wait for a condition."""
        return self.action({"type": "wait", "condition": condition, "ms": ms})

    def press(self, key: str) -> dict[str, Any]:
        """Press a keyboard key."""
        return self.action({"type": "press", "key": key})

    def extract(self, what: str = "page") -> dict[str, Any]:
        """Extract data from the page."""
        return self.action({"type": "extract", "what": what})

    def action(self, action: dict[str, Any]) -> dict[str, Any]:
        """Execute a raw semantic action."""
        if not self.session_id:
            raise RuntimeError("No active session. Call create_session() first.")
        return self._req("POST", f"/session/{self.session_id}/action", action)

    def actions(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        """Execute multiple actions in sequence."""
        if not self.session_id:
            raise RuntimeError("No active session. Call create_session() first.")
        return self._req("POST", f"/session/{self.session_id}/actions", {"actions": actions})

    # ── Auth ────────────────────────────────────────────────

    def configure_auth(self, site: str, username: str = "", password: str = "",
                       totp_secret: str | None = None, mfa_type: str = "none") -> dict[str, Any]:
        """Configure auth credentials for a site."""
        return self._req("POST", f"/session/{self.session_id}/auth", {
            "site": site,
            "credentials": {
                "username": username,
                "password": password,
                "totp_secret": totp_secret,
            },
            "mfa_type": mfa_type,
        })

    # ── Convenience ─────────────────────────────────────────

    def login(self, username: str, password: str, totp_secret: str | None = None) -> dict[str, Any]:
        """Fill login form and submit."""
        self.fill("authentication", "email", username)
        self.fill("authentication", "password", password)
        if totp_secret:
            # Wait for MFA prompt, then fill
            self.wait("page.load", 3000)
            # This is a simplified flow — real MFA would detect the prompt
            pass
        return self.click("submit", context="authentication")

    def search(self, query: str) -> dict[str, Any]:
        """Fill search field and submit."""
        page = self.get_page()
        search_info = page.get("page", {}).get("search")
        if search_info:
            self.fill("search", search_info["fieldName"], query)
            if search_info.get("hasSubmit"):
                return self.click("submit", context="search")
            return self.press("Enter")
        # Fallback: try to find any search-like field
        return self.fill("search", "q", query)

    # ── Context manager ─────────────────────────────────────

    def __enter__(self) -> SemanticBrowser:
        self.create_session()
        return self

    def __exit__(self, *args) -> None:
        self.close()


# ── Quick test ──────────────────────────────────────────────

if __name__ == "__main__":
    browser = SemanticBrowser()
    with browser:
        # Navigate to a test page
        result = browser.navigate("https://httpbin.org/forms/post")
        print("Navigated. Page model keys:", list(result.get("page", {}).keys()))

        # Get the semantic page
        page = browser.get_page()
        print("Forms:", [f.get("purpose") for f in page.get("page", {}).get("forms", [])])

        # Extract specific data
        data = browser.extract("page.forms")
        print("Extracted forms:", data.get("data"))
