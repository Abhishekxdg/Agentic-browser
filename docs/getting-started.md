# Getting Started

## Prerequisites

- Docker (easiest), **or** Bun v1.3+ and Node 18+

---

## 1. Start the server

### Option A — Docker (recommended)

```bash
git clone https://github.com/Abhishekxdg/Sound-Browser
cd Sound-Browser
docker compose up
```

### Option B — Local

```bash
git clone https://github.com/Abhishekxdg/Sound-Browser
cd Sound-Browser
bun install
bunx playwright install chromium
bun run start
```

Server is ready when you see:

```
Sound Browser (semantic) running at http://localhost:3001
```

---

## 2. Verify it's running

```bash
curl http://localhost:3001/health
# {"status":"ok","service":"sound-browser","version":"0.2.0","mode":"semantic"}
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
pip install "git+https://github.com/Abhishekxdg/Sound-Browser.git#subdirectory=sdk/python"
```

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()  # API key from SOUND_BROWSER_API_KEY env var, default "dev-key"

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

Set `SOUND_BROWSER_API_KEY` before starting:

```bash
SOUND_BROWSER_API_KEY=mysecretkey bun run start
```

Or in Docker:
```bash
SOUND_BROWSER_API_KEY=mysecretkey docker compose up
```

Then pass the same key in your requests:
```bash
-H "Authorization: Bearer mysecretkey"
```

---

## Optional: Postgres job queue backend

By default jobs persist to local JSON files. To enable Postgres-backed job persistence:

```bash
SOUND_JOB_BACKEND=postgres \
DATABASE_URL=postgres://user:pass@localhost:5432/sound_browser \
bun run start
```

Check active backend:

```bash
curl -s http://localhost:3001/jobs/backend \
  -H "Authorization: Bearer mysecretkey"
```

---

## Optional: Postgres graph store backend

By default API graphs persist to local JSON files. To enable Postgres-backed graph persistence:

```bash
SOUND_GRAPH_BACKEND=postgres \
DATABASE_URL=postgres://user:pass@localhost:5432/sound_browser \
bun run start
```

Check active backend:

```bash
curl -s http://localhost:3001/graphs/backend \
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

## Use Skills (reusable workflows)

Skills are pre-built workflows that work out of the box. The P2P network auto-discovers skills from other agents.

```bash
# List available skills for a site
curl -s http://localhost:3001/skills?site=zoho.com \
  -H "Authorization: Bearer dev-key"

# Run a discovered skill
curl -s -X POST http://localhost:3001/skills/zoho.create_invoice/run \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "sess_abc123",
    "params": {"customer": "Acme Corp", "amount": "$1,200"}
  }'
```

Skills have a `source` field:
- `builtin` — ships with the project (always free)
- `discovered` — auto-learned from the P2P network (free, browser execution)
- `verified` / `premium` — marketplace skills (Pro+ tier, includes API replay)

Filter by your tier:
```bash
curl -s "http://localhost:3001/skills?site=zoho.com&tier=pro" \
  -H "Authorization: Bearer dev-key"
```

---

## Next steps

- [Page Model](./page-model.md) — understand the JSON structure returned by navigate/page
- [Action Types](./action-types.md) — all actions with examples
- [API Reference](./api-reference.md) — full endpoint reference
- [Python SDK](./python-sdk.md) — SDK methods reference
- [Examples](./examples.md) — real working examples
- [Monetization Model](./monetization-model.md) — pricing tiers and P2P network design
