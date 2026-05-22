# Semantic Page Model

Every call to `/navigate` or `/page` returns a **Semantic Page Model (SPM)** — a structured JSON representation of the current page. Your agent reads this instead of DOM or screenshots.

## Top-level shape

```json
{
  "page": { "url": "...", "title": "...", "viewport": { "width": 1470, "height": 755 } },
  "forms": [...],
  "navigation": [...],
  "content": [...],
  "interactive": [...],
  "tables": [...],
  "lists": [...],
  "search": null,
  "media": [...],
  "dialogs": [...],
  "iframes": [...]
}
```

---

## `page`

Basic page metadata.

```json
{
  "url": "https://mail.zoho.in/zm/#compose",
  "title": "New Mail - Zoho Mail",
  "viewport": { "width": 1470, "height": 755 }
}
```

---

## `forms`

All forms on the page. Each form has an `id`, inferred `purpose`, and arrays of `fields` and `actions` (buttons).

```json
[
  {
    "id": "login-form",
    "purpose": "authentication",
    "fields": [
      {
        "name": "LOGIN_ID",
        "type": "text",
        "label": "Email Address or Mobile Number",
        "placeholder": "Email Address or Mobile Number",
        "required": true,
        "value": ""
      },
      {
        "name": "PASSWORD",
        "type": "password",
        "label": "Password",
        "required": true
      }
    ],
    "actions": [
      {
        "name": "nextbtn",
        "type": "submit",
        "label": "Next",
        "action": "login"
      }
    ]
  }
]
```

**Use form IDs and field names with the `fill` action:**

```json
{"type": "fill", "form": "login-form", "field": "LOGIN_ID", "value": "you@example.com"}
```

If you don't know the exact `id`, use the `purpose` as the form hint — the resolver fuzzy-matches.

---

## `navigation`

All links extracted from nav elements, sidebars, and menus.

```json
[
  { "text": "Home", "href": "/", "type": "link" },
  { "text": "Dashboard", "href": "/dashboard", "type": "link" },
  { "text": "Sign out", "href": "/logout", "type": "button-link", "external": false }
]
```

---

## `content`

Headings and text blocks. Useful for reading page content or confirming navigation.

```json
[
  { "type": "heading", "level": 1, "text": "Invoice #4821" },
  { "type": "paragraph", "text": "Due: June 1, 2026" },
  { "type": "paragraph", "text": "Amount: $1,200.00" }
]
```

---

## `interactive`

Non-form interactive elements: buttons, tabs, toggles, accordions, dropdowns.

```json
[
  { "id": "btn-compose", "type": "button", "label": "New Mail" },
  { "id": "tab-inbox",   "type": "tab",    "label": "Inbox", "state": "open" },
  { "id": "dd-filter",   "type": "dropdown", "label": "Filter" }
]
```

Click these with:
```json
{"type": "click", "target": "New Mail"}
```

---

## `tables`

Tables extracted with headers and rows.

```json
[
  {
    "id": "invoices-table",
    "caption": "Recent Invoices",
    "headers": ["Invoice #", "Client", "Amount", "Status"],
    "rows": [
      ["INV-001", "Acme Corp", "$1,200", "Paid"],
      ["INV-002", "Globex", "$850",   "Pending"]
    ]
  }
]
```

---

## `lists`

Ordered and unordered lists.

```json
[
  {
    "id": "list-0",
    "type": "unordered",
    "items": ["Feature A", "Feature B", "Feature C"]
  }
]
```

---

## `search`

Search input if present on the page.

```json
{ "fieldName": "q", "placeholder": "Search...", "hasSubmit": true }
```

---

## `dialogs`

Active modals, alerts, confirms, drawers.

```json
[
  {
    "type": "modal",
    "title": "Confirm Delete",
    "message": "Are you sure you want to delete this item?",
    "actions": ["Delete", "Cancel"]
  }
]
```

Handle with:
```json
{"type": "handle_dialog", "accept": true}
```

---

## `iframes`

Embedded iframes, each with their own forms and content.

```json
[
  {
    "src": "https://mail.zoho.in/zm/richtext",
    "title": "Text editor area",
    "forms": [],
    "content": [{ "type": "paragraph", "text": "Hi Abhishek," }],
    "interactive": []
  }
]
```

---

## Tips for agents

- **Use `forms[].purpose`** to find the right form without knowing its ID. `"authentication"`, `"search"`, `"contact"`, `"payment"` are common values.
- **Use `forms[].fields[].name`** as the `field` parameter in `fill` actions — it's more stable than labels.
- **Check `dialogs`** after every click — a confirmation dialog may have appeared.
- **Check `interactive`** for buttons not inside a `<form>` element (e.g., Compose, Delete, Save buttons in SPAs).
- **Read `content[0].text`** to confirm you're on the right page after navigation.
