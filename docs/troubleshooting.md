# Troubleshooting

## Chromium failed to start

```
Error: Chromium failed to start. Run: bunx playwright install chromium
  Path tried: /path/to/chromium
```

**Fix:** Install the Chromium binary:

```bash
bunx playwright install chromium
```

Or set `CHROMIUM_PATH` to an existing Chrome/Chromium binary:
```bash
CHROMIUM_PATH=/usr/bin/google-chrome bun run start
```

---

## Port 3001 already in use

```
error: Failed to start server. Is port 3001 in use?
```

**Fix 1:** Kill the existing process:
```bash
lsof -ti:3001 | xargs kill -9
```

**Fix 2:** Use a different port:
```bash
SOUND_BROWSER_PORT=3002 bun run start
```

---

## 401 Unauthorized

```json
{"error": "Invalid API key"}
```

**Fix:** Pass the correct key. Default is `dev-key`:
```bash
-H "Authorization: Bearer dev-key"
```

If you set `SOUND_BROWSER_API_KEY` on the server, use that value.

---

## Session not found (404)

```json
{"error": "Session not found"}
```

The session was closed (either manually or by the 30-minute idle timeout).

**Fix:** Create a new session with `POST /session`.

---

## Action failed: field not found

```json
{"success": false, "error": "Field \"email\" not found in form \"login\""}
```

The semantic resolver couldn't match the field name to a DOM element.

**Fix 1:** Get the page model and check the actual field names:
```bash
curl http://localhost:3001/session/$SID/page | python3 -m json.tool | grep '"name"'
```

**Fix 2:** Use `fill_selector` with a CSS selector instead:
```json
{"type": "fill_selector", "selector": "input[type='email']", "value": "x@y.com"}
```

---

## Action failed: element not visible / click target not found

```json
{"success": false, "error": "No visible element with text \"Submit\" found"}
```

**Fix 1:** Check the actual text on the page:
```bash
curl -X POST http://localhost:3001/session/$SID/evaluate \
  -d '{"expression": "Array.from(document.querySelectorAll(\"button\")).map(b => b.innerText.trim())"}'
```

**Fix 2:** Use `click_selector`:
```json
{"type": "click_selector", "selector": "button[type='submit']"}
```

**Fix 3:** Use `js` evaluate for complex cases:
```json
# POST /session/:id/evaluate
{"expression": "document.querySelector('button.special-class').click()"}
```

---

## Page model is empty or missing forms

The page may not have finished loading, or it's a SPA that renders content after JavaScript runs.

**Fix:** Add a wait before reading the page:
```json
{"type": "wait", "condition": "network.idle", "ms": 2000}
```

Or wait for a specific element:
```json
{"type": "wait_for", "selector": ".main-content"}
```

---

## Email body not set (iframe content)

Some rich-text editors (Zoho Mail, Gmail) use `contenteditable` iframes. The `fill` action can't reach inside iframes.

**Fix:** Use `evaluate` to set the body directly:
```json
{
  "expression": "var iframe = document.querySelector('iframe.editor'); var doc = iframe.contentDocument; doc.body.innerHTML = '<p>Your text here</p>';"
}
```

---

## Chrome zombie processes

If the server crashes without cleaning up, Chrome processes may keep running.

**Fix:**
```bash
pkill -f "Google Chrome for Testing"
pkill -f "chromium"
```

---

## Docker: Chrome won't start (sandbox error)

```
[0522/...] Running as root without --no-sandbox is not supported
```

**Fix:** Add `--no-sandbox` to Chrome args. Set in `docker-compose.yml`:
```yaml
environment:
  - CHROME_FLAGS=--no-sandbox --disable-dev-shm-usage
```

Or pass `extraArgs` when creating a session:
```json
{"headless": true, "extraArgs": ["--no-sandbox", "--disable-dev-shm-usage"]}
```

---

## Debug mode: watch the browser

Run with `HEADLESS=false` to see Chrome on screen:

```bash
HEADLESS=false bun run start
```

Create sessions with `headless: false`:
```json
{"headless": false}
```

Then interact via the API while watching the browser window.
