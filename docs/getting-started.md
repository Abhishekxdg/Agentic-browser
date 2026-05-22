# Getting Started

## Prerequisites

- Docker (easiest), **or** Bun v1.3+ and Node 18+

---

## 1. Start the server

### Option A — Docker (recommended)

```bash
git clone https://github.com/YOUR_USERNAME/agent-browser
cd agent-browser
docker compose up
```

### Option B — Local

```bash
git clone https://github.com/YOUR_USERNAME/agent-browser
cd agent-browser
bun install
bunx playwright install chromium
bun run start
```

Server is ready when you see:

```
Agent Browser (semantic) running at http://localhost:3001
```

---

## 2. Verify it's running

```bash
curl http://localhost:3001/health
# {"status":"ok","service":"agent-browser","version":"0.2.0","mode":"semantic"}
```

---

## 3. Create your first session

```bash
curl -s -X POST http://localhost:3001/session \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"headless": true}'
```

Response:
```json
{
  "session_id": "sess_abc123",
  "status": "created",
  "connected": true
}
```

Save the `session_id` — you'll use it for every subsequent call.

---

## 4. Navigate to a page

```bash
curl -s -X POST http://localhost:3001/session/sess_abc123/navigate \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

Response includes the full [Semantic Page Model](./page-model.md) — structured JSON describing every form, field, button, link, and content block on the page.

---

## 5. Execute an action

```bash
# Click a link by its visible text
curl -s -X POST http://localhost:3001/session/sess_abc123/action \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"type": "click_text", "text": "More information"}'
```

---

## 6. Close the session

```bash
curl -s -X DELETE http://localhost:3001/session/sess_abc123 \
  -H "Authorization: Bearer dev-key"
```

---

## Python quick start

```bash
pip install "git+https://github.com/YOUR_USERNAME/agent-browser.git#subdirectory=sdk/python"
```

```python
from agentbrowser import AgentBrowser

agent = AgentBrowser()  # API key from AGENT_BROWSER_API_KEY env var, default "dev-key"

with agent.session() as sid:
    page = agent.navigate(sid, "https://example.com")
    print(page["page"]["title"])       # "Example Domain"
    print(page["forms"])               # []
    print(page["navigation"])          # list of links

    agent.action(sid, {"type": "click_text", "text": "More information"})
    page2 = agent.get_page(sid)
    print(page2["page"]["url"])        # https://www.iana.org/domains/reserved
```

---

## Change the API key

Set `AGENT_BROWSER_API_KEY` before starting:

```bash
AGENT_BROWSER_API_KEY=mysecretkey bun run start
```

Or in Docker:
```bash
AGENT_BROWSER_API_KEY=mysecretkey docker compose up
```

Then pass the same key in your requests:
```bash
-H "Authorization: Bearer mysecretkey"
```

---

## Watch the browser (headed mode)

Set `HEADLESS=false` to see Chrome open on screen — useful for debugging:

```bash
HEADLESS=false bun run start
```

Or per-session:
```bash
curl -X POST http://localhost:3001/session \
  -d '{"headless": false}' ...
```

---

## Next steps

- [Page Model](./page-model.md) — understand the JSON structure returned by navigate/page
- [Action Types](./action-types.md) — all actions with examples
- [API Reference](./api-reference.md) — full endpoint reference
- [Python SDK](./python-sdk.md) — SDK methods reference
- [Examples](./examples.md) — real working examples
