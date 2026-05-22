# API Reference

Base URL: `http://localhost:3001`

All endpoints require `Authorization: Bearer <API_KEY>` header. Default key is `dev-key`.

---

## Health

### `GET /health`
No auth required.

**Response:**
```json
{"status": "ok", "service": "sound-browser", "version": "0.2.0", "mode": "semantic"}
```

---

## Sessions

### `POST /session`
Create a new browser session (spawns a Chrome process).

**Body:**
```json
{
  "headless": true,
  "proxy": "http://proxy:8080",
  "attachToRunning": false,
  "remoteDebuggingPort": 9222
}
```
All fields optional. `headless` defaults to `true`.

**Response:**
```json
{"session_id": "sess_abc123", "status": "created", "connected": true}
```

---

### `GET /session`
List all active sessions.

**Response:**
```json
{
  "sessions": [
    {"id": "sess_abc123", "createdAt": "2026-05-22T...", "lastActive": "2026-05-22T...", "connected": true}
  ]
}
```

---

### `GET /session/:id`
Get info about one session.

**Response:**
```json
{
  "session_id": "sess_abc123",
  "created_at": "2026-05-22T00:00:00Z",
  "last_active": "2026-05-22T00:05:00Z",
  "connected": true,
  "has_page_model": true
}
```

---

### `DELETE /session/:id`
Close a session and kill the Chrome process.

**Response:**
```json
{"status": "closed", "session_id": "sess_abc123"}
```

---

### `POST /session/:id/reconnect`
Reconnect a dropped WebSocket without killing Chrome.

**Response:**
```json
{"status": "reconnected", "connected": true}
```

---

## Navigation

### `POST /session/:id/navigate`
Navigate to a URL. Waits for page load, then returns the full page model.

**Body:**
```json
{"url": "https://example.com"}
```

**Response:**
```json
{
  "status": "navigated",
  "page": { ...SemanticPage }
}
```

See [Page Model](./page-model.md) for the full shape.

---

## Page

### `GET /session/:id/page`
Get the Semantic Page Model for the current page without navigating.

Query params:
- `?fresh=true` — bypass semantic cache and force fresh extraction.

**Response:**
```json
{"page": { ...SemanticPage }}
```

---

## Semantic Cache

### `GET /semantic-cache`
List cached semantic page entries.

**Response:**
```json
{
  "entries": [
    {"url": "https://example.com/dashboard", "cached_at": 1766441122334, "hits": 5}
  ],
  "count": 1
}
```

### `DELETE /semantic-cache`
Clear semantic cache.

Query params:
- `?url=https://example.com/dashboard` — clear one cached URL.
- no query param — clear all cache entries.

**Response:**
```json
{"status": "cleared", "removed": 1, "scope": "url"}
```

---

## Actions

### `POST /session/:id/action`
Execute one semantic action.

**Body:** any action object — see [Action Types](./action-types.md).

**Response:**
```json
{
  "success": true,
  "data": null,
  "error": null,
  "page": { ...SemanticPage }
}
```

`page` is `null` if the action doesn't trigger a page change.

On failure:
```json
{"success": false, "error": "No visible element with text 'Submit' found", "page": null}
```

---

### `POST /session/:id/actions`
Execute a sequence of actions. Stops on the first failure.

**Body:**
```json
{
  "actions": [
    {"type": "navigate", "url": "https://example.com"},
    {"type": "fill", "form": "login", "field": "email", "value": "x@y.com"},
    {"type": "click", "target": "Sign in"}
  ]
}
```

**Response:**
```json
{
  "results": [
    {"success": true, "data": null, "error": null},
    {"success": true, "data": null, "error": null},
    {"success": false, "data": null, "error": "Button 'Sign in' not found"}
  ],
  "page": { ...SemanticPage }
}
```

---

## JavaScript

### `POST /session/:id/evaluate`
Run arbitrary JavaScript in the page context.

**Body:**
```json
{"expression": "document.title"}
```

**Response:**
```json
{"success": true, "result": "Zoho Mail"}
```

Useful when semantic actions can't reach an element:
```json
{"expression": "Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Send')).click()"}
```

---

## Screenshot

### `GET /session/:id/screenshot`
Returns a PNG binary directly.

Query params:
- `?fullPage=true` — capture full scrollable page (default: viewport only)

```bash
curl -s -H "Authorization: Bearer dev-key" \
  "http://localhost:3001/session/sess_abc123/screenshot" \
  -o screenshot.png
```

---

## Cookies

### `GET /session/:id/cookies`
Get all cookies. Optional `?url=https://example.com` to filter by URL.

**Response:**
```json
{"cookies": [{"name": "session", "value": "abc", "domain": ".example.com", ...}]}
```

### `POST /session/:id/cookies`
Set a cookie.

**Body:**
```json
{"name": "session", "value": "abc123", "domain": ".example.com", "secure": true, "httpOnly": true}
```

### `DELETE /session/:id/cookies`
Clear all cookies for the session.

---

## History

### `POST /session/:id/history`
Navigate back, forward, or refresh.

**Body:**
```json
{"direction": "back"}
```

**Response:** same as `/navigate` — returns updated page model.

---

## Dialogs

### `POST /session/:id/dialog`
Handle an alert/confirm/prompt that's currently open.

**Body:**
```json
{"accept": true, "text": "optional prompt response"}
```

---

## Tabs

### `GET /session/:id/tabs`
List all open tabs.

**Response:**
```json
{"tabs": [{"id": "TAB_ID", "url": "https://...", "title": "...", "active": true}]}
```

### `POST /session/:id/tabs`
Open a new tab.

**Body:** `{}` or `{"url": "https://example.com"}`

**Response:** `{"tab_id": "TAB_ID", "status": "opened"}`

### `PUT /session/:id/tabs/:tabId`
Switch to a tab.

### `DELETE /session/:id/tabs/:tabId`
Close a tab.

---

## State snapshots

### `POST /session/:id/state/save`
Save browser state snapshot profile.

Includes:
- cookies
- localStorage/sessionStorage for current tab origin
- open tab list + active tab

**Body:**
```json
{"profile": "workday-prod"}
```

### `POST /session/:id/state/load`
Restore browser state snapshot profile.

**Body:**
```json
{"profile": "workday-prod"}
```

### `GET /state/profiles`
List saved snapshot profiles.

### `DELETE /state/profiles/:name`
Delete one snapshot profile.

---

## WebSocket streaming

Connect to `ws://localhost:3001/session/:id/stream` to receive real-time page mutation events and send actions.

On connect, receives the current page model:
```json
{"type": "page_model", "data": { ...SemanticPage }}
```

On page mutation:
```json
{"type": "mutation", "data": {"type": "dom_change", "selector": ".inbox-count", "text": "172"}}
```

Send actions over the socket:
```json
{"id": "req_1", "type": "click", "target": "New Mail"}
```

Response:
```json
{"type": "action_result", "id": "req_1", "success": true, "data": null, "page": { ...SemanticPage }}
```

---

## Audit

### `GET /audit/:org`
Read audit entries for org.

Query params:
- `date=YYYY-MM-DD`
- `session_id=sess_...`
- `severity=info|warn|sensitive|critical`
- `limit=100`

**Response:**
```json
{
  "entries": [{ "id": "aud_...", "action_type": "click", "entry_hash": "..." }],
  "count": 1
}
```

### `GET /audit/:org/export`
Export audit entries as NDJSON or CSV.

Query params:
- `format=jsonl|csv` (default `jsonl`)
- supports same filters as `GET /audit/:org`

### `GET /audit/:org/verify`
Verify tamper-evident hash chain.

Query params:
- `date=YYYY-MM-DD` (optional, verify one day)

**Response:**
```json
{"ok": true, "checked": 42}
```

---

## Vault

### `GET /vault/:org`
List encrypted credentials metadata.

Query params:
- `user_id=<id>` (optional; filter one user namespace)

### `POST /vault/:org`
Store credential in encrypted vault.

**Body:**
```json
{
  "site": "github.com",
  "username": "alice",
  "password": "secret",
  "totp_secret": "BASE32...",
  "api_key": "ghp_xxx",
  "user_id": "user-123"
}
```

### `GET /vault/:org/:site`
Get credential metadata and generated TOTP code.

Query params:
- `user_id=<id>` (optional; defaults to `system`)

### `DELETE /vault/:org/:site`
Delete credential.

Query params:
- `user_id=<id>` (optional; defaults to `system`)

---

## Jobs

### `GET /jobs/backend`
Get active jobs persistence backend.

**Response:**
```json
{"backend":"file","postgres_ready":false}
```

When Postgres mode is enabled (`SOUND_JOB_BACKEND=postgres` + `DATABASE_URL`), backend returns `postgres`.

---

## Graphs

### `GET /graphs/backend`
Get active graph store persistence backend.

**Response:**
```json
{"backend":"file","postgres_ready":false}
```

When Postgres mode is enabled (`SOUND_GRAPH_BACKEND=postgres` + `DATABASE_URL`), backend returns `postgres`.

---

## Error responses

All errors return JSON with an `error` field:

| Status | Meaning |
|--------|---------|
| `400` | Missing required field |
| `401` | Invalid or missing API key |
| `404` | Session not found |
| `405` | Method not allowed |
| `500` | Internal error (see `error` field) |
| `501` | Not implemented |
