> **License:** Personal & educational use only. Derivatives must be open source. No commercial use. See [LICENSE](LICENSE).

# Agent Browser

Control any website from your AI agent via a REST API — no CSS selectors, no screenshots, no Playwright wrapper.

The browser exposes every page as structured JSON your LLM can read and act on directly. Give it a form field name and a value; it fills the right input. Give it a button label; it finds and clicks it. No selector debugging, no DOM archaeology.

| Traditional Automation | Agent Browser |
|-----------------------|---------------|
| `click("#login-form > div > button.btn-primary")` | `{"type":"click","target":"Sign in"}` |
| `fill("input[name='email']", "x@y.com")` | `{"type":"fill","form":"login","field":"email","value":"x@y.com"}` |
| Screenshots + vision model | Structured JSON page model |
| Breaks on every UI update | Stable semantic names |

---

## Quick Start

### Option 1 — Docker (no Bun required)

```bash
git clone https://github.com/YOUR_USERNAME/agent-browser
cd agent-browser
docker compose up
```

Server at `http://localhost:3001`.

### Option 2 — Local (requires Bun)

```bash
git clone https://github.com/YOUR_USERNAME/agent-browser
cd agent-browser
bun install
bunx playwright install chromium
bun run start
```

---

## First call

```bash
# 1. Create a session
SESSION=$(curl -s -X POST http://localhost:3001/session \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"headless":true}' | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

# 2. Navigate — returns structured page model
curl -s -X POST http://localhost:3001/session/$SESSION/navigate \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | python3 -m json.tool

# 3. Execute an action
curl -s -X POST http://localhost:3001/session/$SESSION/action \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"type":"click_text","text":"More information"}'
```

---

## Python SDK

Install from GitHub:

```bash
pip install "git+https://github.com/YOUR_USERNAME/agent-browser.git#subdirectory=sdk/python"
```

```python
from agentbrowser import AgentBrowser

agent = AgentBrowser()  # uses AGENT_BROWSER_API_KEY env var, localhost:3001

with agent.session() as sid:
    # Navigate — returns structured page model
    page = agent.navigate(sid, "https://mail.zoho.in")
    print(page["page"]["title"])    # "Zoho Mail"
    print(page["forms"])            # login form with field names
    print(page["interactive"])      # buttons, links

    # Fill and click by semantic name
    agent.action(sid, {"type": "fill", "form": "login", "field": "LOGIN_ID", "value": "you@example.com"})
    agent.action(sid, {"type": "press", "key": "Enter"})

    # Run JS when semantic actions aren't enough
    result = agent.js(sid, "document.title")

    # Screenshot
    agent.screenshot(sid, path="/tmp/page.png")
```

---

## Use with any LLM agent

LLM-agnostic. Give your agent the page model JSON and tell it to call `POST /session/:id/action`. Works with OpenAI function calling, Gemini tool use, Claude tool use, or any agentic framework.

See `examples/gemini-agent.ts` — a working example: Gemini 3.5 Flash agent logs into Zoho Mail and sends an email using only this API.

---

## API reference

### Sessions

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/session` | `{"headless":true}` | Create session → `session_id` |
| `GET` | `/session` | — | List sessions |
| `DELETE` | `/session/:id` | — | Close session |

### Navigation & page

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/session/:id/navigate` | Navigate to URL, returns page model |
| `GET` | `/session/:id/page` | Get current page model |
| `GET` | `/session/:id/screenshot` | PNG screenshot |

### Actions

`POST /session/:id/action` — body is one action object:

```jsonc
{"type":"navigate",       "url":"https://..."}
{"type":"fill",           "form":"formId","field":"fieldName","value":"text"}
{"type":"click",          "target":"Button label"}
{"type":"click_text",     "text":"exact visible text"}
{"type":"click_selector", "selector":"css selector"}
{"type":"fill_selector",  "selector":"css selector","value":"text"}
{"type":"press",          "key":"Enter"}
{"type":"wait",           "condition":"network.idle","ms":2000}
{"type":"scroll",         "direction":"down"}
{"type":"type_text",      "text":"text to type"}
{"type":"screenshot"}
```

`POST /session/:id/actions` — array of actions, stops on first failure.

`POST /session/:id/evaluate` — `{"expression":"JS"}` — runs JS in the page, returns result.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BROWSER_API_KEY` | `dev-key` | Auth key for all requests |
| `AGENT_BROWSER_PORT` | `3001` | Server port |
| `CHROMIUM_PATH` | auto-detected | Override Chromium binary |
| `HEADLESS` | `true` | Set `false` to watch the browser |

---

## Architecture

```
AI Agent (your code)
       │  REST / WebSocket
       ▼
Agent Browser Server     (src/agent-browser/server.ts)
       │
       ├── Session Manager  — one Chrome process per session
       ├── CDP Bridge       — WebSocket to Chrome DevTools Protocol
       ├── Semantic Page    — DOM → structured JSON page model
       └── Action Resolver  — semantic intent → CDP commands
```

---

## Project layout

```
src/agent-browser/   Core: CDP bridge, page model, action resolver, server
src/recorder/        Session recorder (network traffic capture)
src/graph/           API graph extractor
src/executor/        API replay execution engine
sdk/python/          Python client SDK
examples/            Working agent examples (Gemini + Agent Browser demo)
evals/               Evaluation suite (12/12 sites passing)
```

---

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Install, first session, first action end-to-end |
| [Page Model](docs/page-model.md) | JSON structure returned by every navigate/page call |
| [Action Types](docs/action-types.md) | All 30+ action types with examples |
| [API Reference](docs/api-reference.md) | Every endpoint, request shape, response shape |
| [Python SDK](docs/python-sdk.md) | All SDK methods with examples |
| [MCP Setup](docs/mcp-setup.md) | Use directly in Claude Desktop / Claude Code |
| [Examples](docs/examples.md) | Login, form fill, data extract, send email, multi-tab, LLM agent loop |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and fixes |
