# Chrome Extension

The Sound Browser Chrome extension runs agents in your **real browser** — no headless mode, no bot detection, full access to your existing login sessions.

## What it unlocks

| Without Extension | With Extension |
|---|---|
| Headless Chrome (detected by LinkedIn, Cloudflare, etc.) | Real Chrome — identical to human browsing |
| Must log in manually each run | Uses your existing sessions — already logged in |
| Separate Chrome process | Shares your open tabs |
| No side panel UI | Live activity feed while you browse |
| Can't watch recordings happen | See every agent action in real time |

## Install

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

The Sound Browser icon appears in your toolbar. Click it to open the popup, or use the side panel.

## Connect to the server

Start the agent browser server:
```bash
bun run start
# or
docker compose up
```

The extension auto-connects to `ws://localhost:3001/extension/stream`. The status dot in the side panel turns green when connected.

## Use via API

Once the extension is connected, use `/extension/command` to control the real browser:

```bash
# Check if extension is connected
curl http://localhost:3001/extension/status

# Navigate in real Chrome
curl -X POST http://localhost:3001/extension/command \
  -H "Authorization: Bearer dev-key" \
  -H "Content-Type: application/json" \
  -d '{"type":"NAVIGATE","url":"https://gmail.com"}'

# Get page model from real browser (your existing session)
curl -X POST http://localhost:3001/extension/command \
  -H "Authorization: Bearer dev-key" \
  -d '{"type":"GET_PAGE"}'

# Click by label
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"CLICK","target":"Compose"}'

# Fill a field
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"FILL","field":"To","value":"someone@example.com"}'

# Run JavaScript in the page
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"EVAL","expression":"document.title"}'

# Take screenshot
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"SCREENSHOT"}'

# Get real browser cookies (your actual session)
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"GET_COOKIES","url":"https://gmail.com"}'

# Start/stop recording
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"START_RECORDING"}'
# ... perform workflow ...
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"STOP_RECORDING"}'
```

## Python SDK

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

# Check extension
status = agent._get("/extension/status")
print(status["connected"])  # True

# Send command to real browser
def ext(agent, cmd):
    return agent._post("/extension/command", cmd)

# Navigate in real Chrome (uses your existing Gmail session)
page = ext(agent, {"type": "NAVIGATE", "url": "https://mail.google.com"})

# Agent can now interact with Gmail using your real login
ext(agent, {"type": "CLICK", "target": "Compose"})
ext(agent, {"type": "FILL",  "field": "To", "value": "someone@example.com"})
ext(agent, {"type": "FILL",  "field": "Subject", "value": "Hello"})
ext(agent, {"type": "EVAL",  "expression": "document.querySelector('[aria-label=\"Message Body\"]').focus()"})
ext(agent, {"type": "FILL",  "selector": "[aria-label='Message Body']", "value": "Hello from my AI agent!"})
ext(agent, {"type": "EVAL",  "expression": "document.querySelector('[data-tooltip=\"Send\"]').click()"})
```

## Extension commands

| Command | Description |
|---------|-------------|
| `NAVIGATE` | Navigate to URL, wait for load |
| `GET_PAGE` | Extract semantic page model from real browser |
| `CLICK` | Click by label or selector |
| `FILL` | Fill input by field name or selector |
| `PRESS` | Press a keyboard key |
| `SCROLL` | Scroll the page |
| `EVAL` | Run JavaScript in the page |
| `WAIT_FOR` | Wait for a CSS selector to appear |
| `GET_TEXT` | Get text content of a selector |
| `SCREENSHOT` | Capture visible tab as PNG |
| `GET_COOKIES` | Get cookies for a URL (real browser cookies) |
| `SET_COOKIE` | Set a cookie |
| `CLEAR_COOKIES` | Clear cookies for a URL |
| `NEW_TAB` | Open a new tab |
| `SWITCH_TAB` | Switch to a tab by ID |
| `CLOSE_TAB` | Close a tab |
| `LIST_TABS` | List all open tabs |
| `START_RECORDING` | Start capturing network traffic |
| `STOP_RECORDING` | Stop capturing, returns all requests |
| `GET_STATUS` | Extension status |

## Recording in real browser

The extension captures `fetch` and `XHR` calls via a page-injected interceptor. This is more reliable than Playwright's route interception on complex SPAs.

```bash
# Start recording
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"START_RECORDING"}'

# Navigate and perform the workflow manually in Chrome
# The side panel shows captured request count in real time

# Stop and get results
curl -X POST http://localhost:3001/extension/command \
  -d '{"type":"STOP_RECORDING"}'
# Returns: {success:true, requests:[...], count:N}
```

## Side panel

Click the Sound Browser icon and open the side panel to see:
- Connection status (green = server connected)
- Current page title + URL
- Live activity feed of agent actions
- Record workflow button
- Intent input — type what you want the agent to do

## Change server URL / API key

Edit `extension/background/service-worker.js`:
```javascript
const SERVER_URL = 'ws://localhost:3001/extension/stream';
const API_KEY = 'your-api-key';
```

Reload the extension in `chrome://extensions/` after changes.
