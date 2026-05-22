# Python SDK

Install:
```bash
pip install "git+https://github.com/Abhishekxdg/Sound-Browser.git#subdirectory=sdk/python"
```

---

## Setup

```python
from agentbrowser import SoundBrowser

# Default: localhost:3001, API key from SOUND_BROWSER_API_KEY env var (fallback: "dev-key")
agent = SoundBrowser()

# Custom server
agent = SoundBrowser(
    api_key="mysecretkey",
    base_url="http://myserver:3001",
    timeout=120,
)
```

---

## Session management

### Context manager (recommended)

```python
with agent.session() as sid:
    # session created on enter, closed on exit (even if exception)
    page = agent.navigate(sid, "https://example.com")
```

### Manual

```python
sid = agent.create_session(headless=True)
try:
    page = agent.navigate(sid, "https://example.com")
finally:
    agent.close_session(sid)
```

### Methods

| Method | Description |
|--------|-------------|
| `create_session(headless=True, proxy=None) -> str` | Returns `session_id` |
| `close_session(session_id)` | Closes session and Chrome process |
| `session(headless=True)` | Context manager, yields `session_id` |
| `list_sessions() -> list` | All active sessions |

---

## Navigation

```python
page = agent.navigate(sid, "https://example.com")
# page is a dict matching the Semantic Page Model
print(page["page"]["title"])
print(page["page"]["url"])
print(page["forms"])
print(page["interactive"])
```

```python
# Get current page without navigating
page = agent.get_page(sid)

# Force fresh extraction (bypass semantic cache)
page = agent.get_page(sid, fresh=True)
```

---

## Actions

### Single action

```python
result = agent.action(sid, {"type": "click_text", "text": "Sign in"})
# result: {"success": True, "data": ..., "error": None, "page": {...}}

if not result["success"]:
    print(result["error"])
```

### Action sequence

```python
result = agent.actions(sid, [
    {"type": "fill", "form": "login", "field": "LOGIN_ID", "value": "you@example.com"},
    {"type": "press", "key": "Enter"},
    {"type": "wait", "condition": "network.idle"},
    {"type": "fill", "form": "login", "field": "PASSWORD", "value": "secret"},
    {"type": "click_selector", "selector": "#nextbtn"},
])
```

---

## Common action patterns

```python
# Navigate
agent.action(sid, {"type": "navigate", "url": "https://..."})

# Fill a form field (semantic)
agent.action(sid, {"type": "fill", "form": "login", "field": "email", "value": "x@y.com"})

# Fill by CSS selector (fallback)
agent.action(sid, {"type": "fill_selector", "selector": "input[name='email']", "value": "x@y.com"})

# Click by label
agent.action(sid, {"type": "click", "target": "Submit"})

# Click by visible text
agent.action(sid, {"type": "click_text", "text": "Continue to Sign In"})

# Click by CSS selector
agent.action(sid, {"type": "click_selector", "selector": "#submit-btn"})

# Press a key
agent.action(sid, {"type": "press", "key": "Enter"})

# Wait for network to settle
agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 2000})

# Wait for element
agent.action(sid, {"type": "wait_for", "selector": ".success-toast"})

# Scroll
agent.action(sid, {"type": "scroll", "direction": "down"})

# Handle a dialog
agent.action(sid, {"type": "handle_dialog", "accept": True})
```

---

## JavaScript

Run arbitrary JS in the page when semantic actions aren't enough:

```python
title = agent.js(sid, "document.title")
url = agent.js(sid, "window.location.href")

# Click something the semantic actions missed
agent.js(sid, "document.querySelector('button.special').click()")

# Read a value
count = agent.js(sid, "document.querySelectorAll('.item').length")
```

---

## Screenshots

```python
# Save to file
agent.screenshot(sid, path="/tmp/page.png")

# Get bytes
png_bytes = agent.screenshot(sid)
```

---

## Cookies

```python
cookies = agent.get_cookies(sid)
agent.set_cookie(sid, "session", "abc123", domain=".example.com", secure=True)
agent.clear_cookies(sid)
```

---

## Tabs

```python
tabs = agent.list_tabs(sid)
new_tab = agent.open_tab(sid, "https://example.com")
agent.switch_tab(sid, new_tab)
```

---

## Health check

```python
print(agent.health())
# {"status": "ok", "service": "sound-browser", "version": "0.2.0", "mode": "semantic"}
```

---

## Audit + Vault (enterprise)

```python
# Audit
entries = agent.get_audit_log("default", severity="critical", limit=50)
verification = agent.verify_audit_log("default")
csv_export = agent.export_audit_log("default", format="csv")

# Vault (per-user isolation)
agent.set_vault_credential("default", "github.com", username="alice", password="...", user_id="user-1")
creds = agent.list_vault_credentials("default", user_id="user-1")
meta = agent.get_vault_credential("default", "github.com", user_id="user-1")
agent.delete_vault_credential("default", "github.com", user_id="user-1")
```

---

## Semantic cache

```python
entries = agent.list_semantic_cache()
agent.clear_semantic_cache()  # or: agent.clear_semantic_cache("https://example.com/dashboard")
```

---

## Browser state snapshots

```python
agent.save_state_snapshot(sid, "checkout-state")
profiles = agent.list_state_snapshots()
agent.load_state_snapshot(sid, "checkout-state")
agent.delete_state_snapshot("checkout-state")
```

---

## Error handling

```python
from requests.exceptions import HTTPError

try:
    with agent.session() as sid:
        page = agent.navigate(sid, "https://example.com")
        result = agent.action(sid, {"type": "click", "target": "Nonexistent Button"})
        if not result["success"]:
            print(f"Action failed: {result['error']}")
except HTTPError as e:
    print(f"API error {e.response.status_code}: {e.response.text}")
```
