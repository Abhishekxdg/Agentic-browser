# Examples

## 1. Login to a web app

The most common pattern: fill login form, submit, wait, confirm.

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    # Navigate to login page
    page = agent.navigate(sid, "https://accounts.zoho.in/signin")

    # Find the form (purpose: "authentication")
    auth_form = next((f for f in page["forms"] if f.get("purpose") == "authentication"), None)
    print("Fields:", [f["name"] for f in auth_form["fields"]])
    # → ['LOGIN_ID', ...]

    # Fill email
    agent.action(sid, {
        "type": "fill",
        "form": "authentication",
        "field": "LOGIN_ID",
        "value": "you@example.com"
    })

    # Click Next (or press Enter)
    agent.js(sid, "document.getElementById('nextbtn').click()")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 2000})

    # Fill password
    agent.action(sid, {
        "type": "fill",
        "form": "authentication",
        "field": "PASSWORD",
        "value": "your-password"
    })

    # Submit
    agent.js(sid, "document.getElementById('nextbtn').click()")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 5000})

    # Confirm login
    page = agent.get_page(sid)
    print("Logged in at:", page["page"]["url"])
```

---

## 2. Fill and submit a form

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    page = agent.navigate(sid, "https://httpbin.org/forms/post")

    # Read the form structure
    for form in page["forms"]:
        print(f"Form '{form['id']}': {[f['name'] for f in form['fields']]}")

    # Fill fields
    agent.actions(sid, [
        {"type": "fill", "form": "form", "field": "custname", "value": "Jane Doe"},
        {"type": "fill", "form": "form", "field": "custtel",  "value": "555-1234"},
        {"type": "fill", "form": "form", "field": "custemail","value": "jane@example.com"},
        {"type": "select","form": "form", "field": "size",    "option": "Large"},
        {"type": "click", "target": "Submit order"},
    ])

    # Read result
    page = agent.get_page(sid)
    body = next((c["text"] for c in page["content"]), "")
    print(body)
```

---

## 3. Extract data from a table

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    page = agent.navigate(sid, "https://en.wikipedia.org/wiki/List_of_countries_by_GDP")

    for table in page["tables"]:
        print(f"\nTable: {table.get('caption', table['id'])}")
        print("Headers:", table["headers"])
        for row in table["rows"][:3]:
            print(" ", row)
```

---

## 4. Send an email (Zoho Mail)

Full working example — the same flow demonstrated to build this project.

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    # Login
    agent.navigate(sid, "https://accounts.zoho.in/signin")
    agent.action(sid, {"type": "fill", "form": "authentication", "field": "LOGIN_ID", "value": "you@convos.store"})
    agent.js(sid, "document.getElementById('nextbtn').click()")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 2000})
    agent.action(sid, {"type": "fill", "form": "authentication", "field": "PASSWORD", "value": "your-password"})
    agent.js(sid, "document.getElementById('nextbtn').click()")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 5000})

    # Navigate to mail
    agent.navigate(sid, "https://mail.zoho.in/")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 3000})

    # Open compose
    agent.js(sid, "document.querySelector('button.zmbtn--mbtn__xm5hob').click()")
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 2000})

    # Fill To
    agent.js(sid, """
        var toInput = document.querySelector('input[aria-label="To Recipients"]');
        toInput.focus();
        toInput.value = 'recipient@example.com';
        toInput.dispatchEvent(new Event('input', {bubbles: true}));
    """)
    agent.action(sid, {"type": "press", "key": "Enter"})

    # Fill Subject
    agent.js(sid, """
        var s = document.getElementById('input-_r_t_');
        s.value = 'Hello from Sound Browser';
        s.dispatchEvent(new Event('input', {bubbles: true}));
    """)

    # Fill body via iframe
    agent.js(sid, """
        var iframe = document.querySelector('iframe.ze_area');
        var doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.body.innerHTML = '<p>This email was sent by an AI agent using Sound Browser.</p>';
    """)

    # Send
    agent.js(sid, """
        Array.from(document.querySelectorAll('button'))
          .find(b => b.innerText.trim() === 'Send')
          .click();
    """)
    agent.action(sid, {"type": "wait", "condition": "network.idle", "ms": 3000})

    print("Email sent.")
    agent.screenshot(sid, path="/tmp/sent-confirmation.png")
```

---

## 5. Multi-tab workflow

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    # Tab 1: login
    agent.navigate(sid, "https://app.example.com/login")
    agent.actions(sid, [
        {"type": "fill", "form": "login", "field": "email",    "value": "x@y.com"},
        {"type": "fill", "form": "login", "field": "password", "value": "secret"},
        {"type": "click", "target": "Log in"},
        {"type": "wait", "condition": "network.idle"},
    ])

    # Open second tab
    tab2 = agent.open_tab(sid, "https://app.example.com/invoices")
    agent.switch_tab(sid, tab2)

    page = agent.get_page(sid)
    invoices = page["tables"][0]["rows"] if page["tables"] else []
    print(f"Found {len(invoices)} invoices")
```

---

## 6. Use with Gemini (or any LLM)

See `examples/gemini-agent.ts` for a complete TypeScript example where Gemini 3.5 Flash drives the browser autonomously.

The pattern works with any LLM that supports function/tool calling:

1. Pass the page model JSON to the LLM as context
2. Define tools: `navigate`, `action`, `get_page`, `js`, `screenshot`
3. The LLM calls tools to complete the task
4. Each tool call hits the Sound Browser REST API

```python
# Pseudocode — works with any LLM SDK
def agent_loop(task: str):
    sid = agent.create_session()
    messages = [{"role": "user", "content": task}]

    while True:
        response = llm.chat(messages, tools=BROWSER_TOOLS)

        if response.finish_reason == "stop":
            break

        for tool_call in response.tool_calls:
            if tool_call.name == "navigate":
                result = agent.navigate(sid, tool_call.args["url"])
            elif tool_call.name == "action":
                result = agent.action(sid, tool_call.args["action"])
            elif tool_call.name == "js":
                result = agent.js(sid, tool_call.args["expression"])

            messages.append({"role": "tool", "content": str(result)})
```
