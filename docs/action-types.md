# Action Types

All actions are sent via `POST /session/:id/action` with a JSON body. Use `POST /session/:id/actions` to run a sequence.

---

## Navigation

### `navigate`
Navigate to a URL.
```json
{"type": "navigate", "url": "https://example.com"}
```

### `history`
Go back, forward, or refresh.
```json
{"type": "history", "direction": "back"}
{"type": "history", "direction": "forward"}
{"type": "history", "direction": "refresh"}
```

---

## Forms

### `fill`
Fill a form field by semantic name. The resolver looks up the field in the current page model.
```json
{"type": "fill", "form": "login", "field": "email", "value": "you@example.com"}
{"type": "fill", "form": "checkout", "field": "card_number", "value": "4242424242424242"}
```
`form` — form `id` or inferred `purpose` (e.g. `"authentication"`, `"search"`)
`field` — field `name` from page model

### `fill_selector`
Fill an input by CSS selector. Use when `fill` can't resolve the field.
```json
{"type": "fill_selector", "selector": "input[name='email']", "value": "you@example.com"}
{"type": "fill_selector", "selector": "#search-box", "value": "agent browser"}
```

### `select`
Choose a dropdown option by value or visible label.
```json
{"type": "select", "form": "settings", "field": "country", "option": "India"}
```

### `type_text`
Type text into the currently focused element (no target needed).
```json
{"type": "type_text", "text": "Hello world"}
```

---

## Clicking

### `click`
Click a button or interactive element by semantic label. Searches the page model.
```json
{"type": "click", "target": "Sign in"}
{"type": "click", "target": "Submit", "context": "authentication"}
```
`context` narrows the search to a specific form or area.

### `click_text`
Click any visible element by its exact text content.
```json
{"type": "click_text", "text": "Continue to Sign In"}
{"type": "click_text", "text": "New Mail"}
```

### `click_selector`
Click by CSS selector.
```json
{"type": "click_selector", "selector": "#nextbtn"}
{"type": "click_selector", "selector": "button.compose-btn"}
```

### `click_coords`
Click at pixel coordinates (x, y).
```json
{"type": "click_coords", "x": 740, "y": 400}
```

### `double_click`
Double-click by semantic label.
```json
{"type": "double_click", "target": "filename.txt"}
```

### `right_click`
Right-click by semantic label.
```json
{"type": "right_click", "target": "filename.txt"}
```

### `hover`
Hover over an element (triggers tooltips, dropdowns).
```json
{"type": "hover", "target": "Account menu"}
```

---

## Keyboard

### `press`
Press a key. Standard key names: `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowDown`, `ArrowUp`, `Space`.
```json
{"type": "press", "key": "Enter"}
{"type": "press", "key": "Escape"}
{"type": "press", "key": "Tab"}
```

### `keyboard_shortcut`
Press a key combination.
```json
{"type": "keyboard_shortcut", "modifiers": ["Ctrl"], "key": "a"}
{"type": "keyboard_shortcut", "modifiers": ["Meta"], "key": "k"}
{"type": "keyboard_shortcut", "modifiers": ["Ctrl", "Shift"], "key": "i"}
```

---

## Scrolling

### `scroll`
```json
{"type": "scroll", "direction": "down"}
{"type": "scroll", "direction": "up"}
{"type": "scroll", "direction": "bottom"}
{"type": "scroll", "direction": "top"}
{"type": "scroll", "direction": "down", "amount": 500}
```

---

## Waiting

### `wait`
```json
{"type": "wait", "condition": "network.idle"}
{"type": "wait", "condition": "page.load"}
{"type": "wait", "condition": "time", "ms": 2000}
```

### `wait_for`
Wait for an element to appear (up to `timeoutMs`, default 15s).
```json
{"type": "wait_for", "selector": ".success-toast"}
{"type": "wait_for", "selector": "#dashboard", "timeoutMs": 10000}
```

---

## Reading data

### `extract`
Extract structured data from the page model.
```json
{"type": "extract", "what": "page.forms"}
{"type": "extract", "what": "page.tables"}
{"type": "extract", "what": "page.content"}
```

### `get_text`
Get the text content of an element.
```json
{"type": "get_text", "selector": "h1"}
{"type": "get_text", "selector": ".invoice-total"}
```

### `get_iframes`
List all iframes on the page.
```json
{"type": "get_iframes"}
```

---

## Dialogs

### `handle_dialog`
Accept or dismiss an alert/confirm/prompt.
```json
{"type": "handle_dialog", "accept": true}
{"type": "handle_dialog", "accept": false}
{"type": "handle_dialog", "accept": true, "text": "my answer"}
```

---

## Drag & drop

### `drag_drop`
```json
{"type": "drag_drop", "from": "Drag me", "to": "Drop zone"}
```

---

## File upload

### `upload_file`
```json
{"type": "upload_file", "target": "file input", "files": ["/tmp/invoice.pdf"]}
```

---

## Cookies

### `get_cookies`
```json
{"type": "get_cookies"}
{"type": "get_cookies", "url": "https://example.com"}
```

### `set_cookie`
```json
{
  "type": "set_cookie",
  "name": "session",
  "value": "abc123",
  "domain": ".example.com",
  "secure": true
}
```

### `clear_cookies`
```json
{"type": "clear_cookies"}
```

---

## Storage

### `get_storage`
```json
{"type": "get_storage", "storageType": "local"}
{"type": "get_storage", "storageType": "session"}
```

### `set_storage`
```json
{"type": "set_storage", "storageType": "local", "key": "theme", "value": "dark"}
```

---

## Tabs

### `open_tab`
```json
{"type": "open_tab"}
{"type": "open_tab", "url": "https://example.com"}
```

### `switch_tab`
```json
{"type": "switch_tab", "tabId": "TAB_ID"}
```

### `close_tab`
```json
{"type": "close_tab", "tabId": "TAB_ID"}
```

### `list_tabs`
```json
{"type": "list_tabs"}
```

---

## Screenshot

```json
{"type": "screenshot"}
{"type": "screenshot", "fullPage": true}
```

Returns `{"data": "<base64 PNG>"}`.

Or use the dedicated endpoint `GET /session/:id/screenshot` to receive binary PNG.

---

## Fallback strategy

When semantic actions fail, escalate:

1. `click` / `fill` — uses page model (most reliable for standard forms)
2. `click_text` — searches visible text (works for buttons outside forms)
3. `click_selector` — raw CSS selector (always works if selector is correct)
4. `click_coords` — pixel coordinates (last resort)
5. `/evaluate` endpoint — arbitrary JavaScript
