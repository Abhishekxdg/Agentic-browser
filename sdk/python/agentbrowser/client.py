"""Python SDK client for Sound Browser — Semantic Browser for AI Agents."""

import os
import base64
from contextlib import contextmanager
from typing import Optional, Dict, Any, List, Generator
from urllib.parse import quote
import requests


class AgentBrowserError(Exception):
    pass


class AgentBrowser:
    """
    Client for the Sound Browser semantic REST API.

    Usage:
        agent = AgentBrowser()  # uses SOUND_BROWSER_API_KEY env var, localhost:3001

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
        self.api_key = api_key or os.environ.get("SOUND_BROWSER_API_KEY") or os.environ.get("AGENT_BROWSER_API_KEY", "dev-key")
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

    def get_page(self, session_id: str, fresh: bool = False) -> Dict[str, Any]:
        """Get the current semantic page model (forms, links, content, interactive)."""
        q = "?fresh=true" if fresh else ""
        data = self._get(f"/session/{session_id}/page{q}")
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

    def save_state_snapshot(self, session_id: str, profile: str) -> Dict[str, Any]:
        """Save browser state snapshot profile (cookies + storage + tabs)."""
        return self._post(f"/session/{session_id}/state/save", {"profile": profile})

    def load_state_snapshot(self, session_id: str, profile: str) -> Dict[str, Any]:
        """Load browser state snapshot profile."""
        return self._post(f"/session/{session_id}/state/load", {"profile": profile})

    def list_state_snapshots(self) -> List[str]:
        """List available browser state snapshot profiles."""
        return self._get("/state/profiles").get("profiles", [])

    def delete_state_snapshot(self, profile: str) -> Dict[str, Any]:
        """Delete browser state snapshot profile."""
        return self._delete(f"/state/profiles/{quote(profile)}")

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

    def list_semantic_cache(self) -> List[Dict[str, Any]]:
        """List semantic page cache entries."""
        return self._get("/semantic-cache").get("entries", [])

    def clear_semantic_cache(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Clear semantic cache globally or for one URL."""
        q = f"?url={quote(url)}" if url else ""
        return self._delete(f"/semantic-cache{q}")

    # ── Audit logs ──────────────────────────────────────────────────────────

    def get_audit_log(
        self,
        org_id: str,
        date: Optional[str] = None,
        session_id: Optional[str] = None,
        severity: Optional[str] = None,
        limit: int = 100,
    ) -> Dict[str, Any]:
        """Get audit entries for an org."""
        params = []
        if date: params.append(f"date={quote(date)}")
        if session_id: params.append(f"session_id={quote(session_id)}")
        if severity: params.append(f"severity={quote(severity)}")
        if limit: params.append(f"limit={limit}")
        q = f"?{'&'.join(params)}" if params else ""
        return self._get(f"/audit/{quote(org_id)}{q}")

    def verify_audit_log(self, org_id: str, date: Optional[str] = None) -> Dict[str, Any]:
        """Verify tamper-evident audit hash chain."""
        q = f"?date={quote(date)}" if date else ""
        return self._get(f"/audit/{quote(org_id)}/verify{q}")

    def export_audit_log(
        self,
        org_id: str,
        format: str = "jsonl",
        date: Optional[str] = None,
        session_id: Optional[str] = None,
        severity: Optional[str] = None,
        limit: int = 1000,
    ) -> str:
        """Export audit entries as raw jsonl/csv text."""
        params = [f"format={quote(format)}"]
        if date: params.append(f"date={quote(date)}")
        if session_id: params.append(f"session_id={quote(session_id)}")
        if severity: params.append(f"severity={quote(severity)}")
        if limit: params.append(f"limit={limit}")
        q = f"?{'&'.join(params)}"
        resp = requests.get(
            f"{self.base_url}/audit/{quote(org_id)}/export{q}",
            headers=self._headers,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.text

    # ── Vault ───────────────────────────────────────────────────────────────

    def list_vault_credentials(self, org_id: str, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
        q = f"?user_id={quote(user_id)}" if user_id else ""
        return self._get(f"/vault/{quote(org_id)}{q}").get("credentials", [])

    def set_vault_credential(
        self,
        org_id: str,
        site: str,
        username: Optional[str] = None,
        password: Optional[str] = None,
        totp_secret: Optional[str] = None,
        api_key: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"site": site}
        if username is not None: payload["username"] = username
        if password is not None: payload["password"] = password
        if totp_secret is not None: payload["totp_secret"] = totp_secret
        if api_key is not None: payload["api_key"] = api_key
        if user_id is not None: payload["user_id"] = user_id
        return self._post(f"/vault/{quote(org_id)}", payload)

    def get_vault_credential(self, org_id: str, site: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        q = f"?user_id={quote(user_id)}" if user_id else ""
        return self._get(f"/vault/{quote(org_id)}/{quote(site)}{q}")

    def delete_vault_credential(self, org_id: str, site: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        q = f"?user_id={quote(user_id)}" if user_id else ""
        return self._delete(f"/vault/{quote(org_id)}/{quote(site)}{q}")

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

    # ── Reliability: tracing + verification ────────────────────────────────

    def start_trace(self, session_id: str) -> Dict[str, Any]:
        """
        Enable action tracing for a session. Every subsequent action records:
        timestamp, action, result, confidence, strategy used, verification outcome,
        page state before/after.

        Use for debugging, replay, training data, and evals.
        """
        return self._post(f"/session/{session_id}/trace/start", {})

    def stop_trace(self, session_id: str) -> Dict[str, Any]:
        """Stop action tracing."""
        return self._post(f"/session/{session_id}/trace/stop", {})

    def get_trace(self, session_id: str) -> List[Dict[str, Any]]:
        """
        Get all recorded trace entries for a session.
        Each entry includes: action, result, confidence, strategy, verification, page_before/after.
        """
        return self._get(f"/session/{session_id}/trace").get("entries", [])

    # ── Event Awareness ────────────────────────────────────────────────────

    def get_events(self, session_id: str, pending_only: bool = False) -> List[Dict[str, Any]]:
        """
        Get page events detected in this session.
        Events include: modal_opened, auth_challenge, error_appeared, captcha_appeared,
        ajax_completed, navigation_completed, toast_appeared.

        Set pending_only=True to get only events that require agent action.
        """
        path = f"/session/{session_id}/events"
        if pending_only:
            path += "?pending=true"
        return self._get(path).get("events", [])

    def clear_events(self, session_id: str) -> Dict[str, Any]:
        """Clear the event history for a session."""
        return self._delete(f"/session/{session_id}/events")

    def get_graph_diffs(self, session_id: str, since: int = 0) -> Dict[str, Any]:
        """
        Get semantic graph diffs since a timestamp.
        Returns: {diffs, mutation_count, last_full_extract}
        Use to understand what changed without re-reading the whole page.
        """
        return self._get(f"/session/{session_id}/graph/diffs?since={since}")

    # ── Workflow Graph Engine ──────────────────────────────────────────────

    def list_workflows(self) -> List[Dict[str, Any]]:
        """List all saved workflow DAGs."""
        return self._get("/workflows").get("workflows", [])

    def save_workflow(self, name: str, site: str, nodes: List[Dict], edges: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """
        Save a workflow DAG. Each node has: id, label, actions[], depends_on[], max_retries.

        Example:
            agent.save_workflow("login_and_search", "https://app.example.com", nodes=[
                {"id": "login", "label": "Log in", "actions": [
                    {"type": "navigate", "url": "https://app.example.com/login"},
                    {"type": "fill", "form": "login", "field": "email", "value": "me@x.com"},
                    {"type": "press", "key": "Enter"},
                ], "depends_on": [], "max_retries": 2, "checkpoint": True, "optional": False},
                {"id": "search", "label": "Search", "actions": [
                    {"type": "fill", "form": "search", "field": "q", "value": "python"},
                    {"type": "press", "key": "Enter"},
                ], "depends_on": ["login"], "max_retries": 1, "checkpoint": False, "optional": False},
            ])
        """
        return self._post("/workflows", {"name": name, "site": site, "nodes": nodes, "edges": edges or []})

    def run_workflow(self, session_id: str, workflow_id: str, resume_from: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute a saved workflow DAG. Respects node dependencies, retries, and checkpoints.

        Args:
            session_id: Active browser session
            workflow_id: ID returned from save_workflow()
            resume_from: Node ID to resume from (skips preceding nodes)

        Returns: WorkflowRun with node_statuses, node_results, success/failure
        """
        payload: Dict[str, Any] = {"workflow_id": workflow_id}
        if resume_from:
            payload["resume_from"] = resume_from
        return self._post(f"/session/{session_id}/workflow/run", payload)

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
