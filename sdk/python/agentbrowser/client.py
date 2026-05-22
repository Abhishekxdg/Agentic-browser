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

    # ── Layer 2: Recording ─────────────────────────────────────────────────

    def start_recording(self, site_url: str, org_id: str = "default") -> Dict[str, Any]:
        """
        Open a headed browser and start recording network traffic.
        The browser window will appear — perform the workflow manually.
        Then call stop_recording().

        Returns: {recording_id, org_id, site_url, message}
        """
        return self._post("/record/start", {"site_url": site_url, "org_id": org_id})

    def stop_recording(self, site_url: str, workflow_name: str, org_id: str = "default") -> Dict[str, Any]:
        """
        Stop recording and save the API graph to disk.

        Args:
            site_url: Same URL used in start_recording()
            workflow_name: Name for this workflow, e.g. "submit_invoice"
            org_id: Organization ID (default: "default")

        Returns: {workflow_name, endpoints_captured, graph_version, node_count}
        """
        return self._post("/record/stop", {
            "site_url": site_url,
            "workflow_name": workflow_name,
            "org_id": org_id,
        })

    def list_recordings(self) -> List[Dict[str, Any]]:
        """List active (in-progress) recording sessions."""
        return self._get("/record/active").get("recordings", [])

    # ── Layer 2: Graphs ────────────────────────────────────────────────────

    def list_graphs(self, org_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all saved API graphs."""
        path = "/graphs"
        if org_id:
            path += f"?org_id={org_id}"
        return self._get(path).get("graphs", [])

    def get_graph(self, site_host: str, org_id: str = "default") -> Dict[str, Any]:
        """Get a saved API graph for a site."""
        return self._get(f"/graphs/{org_id}/{site_host}")

    def delete_graph(self, site_host: str, org_id: str = "default") -> Dict[str, Any]:
        """Delete a saved API graph."""
        return self._delete(f"/graphs/{org_id}/{site_host}")

    # ── Layer 2: Execute intent ────────────────────────────────────────────

    def do(
        self,
        site: str,
        intent: str,
        org_id: str = "default",
        auth_token: Optional[str] = None,
        cookies: Optional[Dict[str, str]] = None,
        llm_provider: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute a natural language intent against a recorded API graph.
        Requires at least one recorded workflow for the site (use start_recording/stop_recording).

        Args:
            site: Target site URL, e.g. "https://invoicing.app"
            intent: What to do, e.g. "submit invoice for $1,200 to Acme Corp"
            org_id: Organization ID (must match the org used during recording)
            auth_token: Bearer token if the site requires auth
            cookies: Cookie dict if cookie-based auth
            llm_provider: "gemini", "openai", or "keyword" (auto-detected if None)

        Returns: {success, intent, site, steps, error, graph_version}

        Example:
            agent = AgentBrowser()

            # Record once:
            agent.start_recording("https://invoicing.app")
            # ... user manually submits an invoice in the browser ...
            agent.stop_recording("https://invoicing.app", "submit_invoice")

            # Then replay anytime:
            result = agent.do("https://invoicing.app", "submit invoice for $500 to Globex")
            print(result["steps"])
        """
        payload: Dict[str, Any] = {"site": site, "intent": intent, "org_id": org_id}
        if auth_token:
            payload["auth_token"] = auth_token
        if cookies:
            payload["cookies"] = cookies
        if llm_provider:
            payload["llm_provider"] = llm_provider
        return self._post("/do", payload)

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

    # ── Intelligence ───────────────────────────────────────────────────────

    def configure_auth(
        self,
        session_id: str,
        username: str,
        password: str,
        site: Optional[str] = None,
        totp_secret: Optional[str] = None,
        mfa_type: Optional[str] = None,
        captcha_key: Optional[str] = None,
        captcha_service: str = "2captcha",
    ) -> Dict[str, Any]:
        """
        Store credentials for auto-login. After this, navigate() will auto-fill
        and submit the login form if one is detected.

        Example:
            agent.configure_auth(sid, "me@x.com", "mypassword", site="github.com")
            page = agent.navigate(sid, "https://github.com/login")
            # page model shows logged-in state — login handled automatically
        """
        payload: Dict[str, Any] = {"username": username, "password": password}
        if site: payload["site"] = site
        if totp_secret: payload["totp_secret"] = totp_secret
        if mfa_type: payload["mfa_type"] = mfa_type
        if captcha_key: payload["captcha_key"] = captcha_key
        if captcha_service: payload["captcha_service"] = captcha_service
        return self._post(f"/session/{session_id}/auth/configure", payload)

    def login(self, session_id: str) -> Dict[str, Any]:
        """Manually trigger auto-login on the current page (requires configure_auth first)."""
        return self._post(f"/session/{session_id}/auth/login", {})

    def run(
        self,
        session_id: str,
        goal: str,
        max_steps: int = 20,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run an autonomous LLM agent loop to accomplish a goal.
        The agent observes the page, reasons, and takes actions until done.

        Requires GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY on the server,
        or pass api_key explicitly.

        Example:
            sid = agent.create_session()
            agent.navigate(sid, "https://github.com/login")
            result = agent.run(sid, "Star the repository torvalds/linux")
            print(result["final_answer"])
            print(result["steps"])
        """
        payload: Dict[str, Any] = {"goal": goal, "max_steps": max_steps}
        if provider: payload["provider"] = provider
        if model: payload["model"] = model
        if api_key: payload["api_key"] = api_key
        return self._post(f"/session/{session_id}/run", payload)

    def vision(
        self,
        session_id: str,
        intent: str,
        api_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Take a screenshot of the current page and ask an LLM what actions
        to take for the given intent. Returns suggested_actions list.

        Useful when semantic extraction misses elements (custom UI components, canvas).
        """
        payload: Dict[str, Any] = {"intent": intent}
        if api_key: payload["api_key"] = api_key
        return self._post(f"/session/{session_id}/vision", payload)

    # ── Memory ─────────────────────────────────────────────────────────────

    def list_memories(self) -> List[Dict[str, Any]]:
        """List all learned site memories."""
        return self._get("/memory").get("memories", [])

    def get_memory(self, site_host: str) -> Dict[str, Any]:
        """Get learned memory for a specific site."""
        return self._get(f"/memory/{site_host}")

    def clear_memory(self, site_host: str) -> Dict[str, Any]:
        """Clear learned memory for a site."""
        return self._delete(f"/memory/{site_host}")

    # ── Task planner ────────────────────────────────────────────────────────

    def plan(
        self,
        session_id: str,
        goal: str,
        max_subtasks: int = 8,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Break a high-level goal into subtasks and execute each with checkpoints.
        Better than run() for complex multi-step goals.

        Example:
            result = agent.plan(sid, "Book a flight from NYC to Tokyo in March")
        """
        payload: Dict[str, Any] = {"goal": goal, "max_subtasks": max_subtasks}
        if provider: payload["provider"] = provider
        if model: payload["model"] = model
        if api_key: payload["api_key"] = api_key
        return self._post(f"/session/{session_id}/plan", payload)

    # ── Iframe actions ─────────────────────────────────────────────────────

    def iframe_fill(self, session_id: str, iframe_src: str, selector: str, value: str) -> Dict[str, Any]:
        """Fill an input inside an iframe (Stripe, Zoho editor, bank portals)."""
        return self._post(f"/session/{session_id}/iframe/fill", {"iframe_src": iframe_src, "selector": selector, "value": value})

    def iframe_click(self, session_id: str, iframe_src: str, selector: str) -> Dict[str, Any]:
        """Click an element inside an iframe."""
        return self._post(f"/session/{session_id}/iframe/click", {"iframe_src": iframe_src, "selector": selector})

    def iframe_eval(self, session_id: str, iframe_src: str, expression: str) -> Dict[str, Any]:
        """Run JavaScript inside an iframe."""
        return self._post(f"/session/{session_id}/iframe/eval", {"iframe_src": iframe_src, "expression": expression})

    # ── Async jobs ─────────────────────────────────────────────────────────

    def submit_job(
        self,
        goal: str,
        site_url: Optional[str] = None,
        job_type: str = "run",
        max_steps: int = 20,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        webhook_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Submit a long-running agent job. Returns immediately with job_id.
        Poll get_job(job_id) for status and result.

        Example:
            job = agent.submit_job("Scrape all invoices from QuickBooks", site_url="https://qbo.intuit.com")
            while True:
                status = agent.get_job(job["job_id"])
                if status["status"] in ("done", "failed"): break
                time.sleep(5)
            print(status["result"])
        """
        payload: Dict[str, Any] = {"goal": goal, "type": job_type, "max_steps": max_steps}
        if site_url: payload["site_url"] = site_url
        if provider: payload["provider"] = provider
        if model: payload["model"] = model
        if api_key: payload["api_key"] = api_key
        if webhook_url: payload["webhook_url"] = webhook_url
        return self._post("/jobs", payload)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        """Get job status and result. Status: queued|running|done|failed|cancelled|waiting_hitl"""
        return self._get(f"/jobs/{job_id}")

    def list_jobs(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all jobs, optionally filtered by status."""
        path = "/jobs"
        if status: path += f"?status={status}"
        return self._get(path).get("jobs", [])

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        """Cancel a running or queued job."""
        return self._delete(f"/jobs/{job_id}")

    def resolve_hitl(self, job_id: str, resolution: str) -> Dict[str, Any]:
        """
        Resolve a job waiting for human input (HITL).
        The job resumes automatically after this call.

        Example:
            # Job paused waiting for 2FA code
            agent.resolve_hitl(job_id, "123456")
        """
        return self._post(f"/jobs/{job_id}/resolve", {"resolution": resolution})

    def pool_stats(self) -> Dict[str, Any]:
        """Get Chrome pool stats: active, idle, queued sessions."""
        return self._get("/pool")

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
