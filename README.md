<div align="center">

# Agent Browser

### The semantic runtime layer for autonomous web agents.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/Abhishekxdg/Agentic-browser)
&nbsp;
[![License](https://img.shields.io/badge/license-Non--Commercial-blue)](LICENSE)
&nbsp;
[![Roadmap](https://img.shields.io/badge/roadmap-v2.0-green)](ROADMAP.md)

</div>

---

Every browser agent system today makes the same mistake: they hand raw DOM, screenshots, or accessibility trees to an LLM and hope it figures out what's on the page. That's expensive, slow, and fragile.

Agent Browser takes a different approach. Instead of asking an LLM to interpret the browser, we **interpret the browser for it** — converting every page into a structured semantic model that agents can reason over directly, no vision model required.

```
CURRENT APPROACH (everyone else)        AGENT BROWSER
──────────────────────────────────      ──────────────────────────────────
Web Page                                Web Page
  ↓                                       ↓
Raw DOM / Screenshot / A11y tree        Semantic Runtime Layer
  ↓                                       ↓
LLM interprets messy structure          Structured Intent Graph (JSON)
  ↓                                       ↓
Agent reasons on noise                  Agent reasons on meaning
  ↓                                       ↓
Playwright executes                     Execution Engine
```

The result: agents that operate on **intent**, not selectors.

```python
# Every other tool                      # Agent Browser
page.click("#login-form > div >         action({"type": "submit",
  button.btn-primary")                    "form": "authentication"})

page.fill("input[name='email']",        action({"type": "fill",
  "x@y.com")                              "form": "login",
                                          "field": "email",
                                          "value": "x@y.com"})
```

---

## Why This Architecture Wins

| Problem with current tools | Agent Browser solution |
|---------------------------|----------------------|
| LLM reads 5000+ tokens of raw DOM | Semantic JSON: ~300 tokens, structured meaning |
| Selector breaks on every UI update | Semantic names survive redesigns |
| Screenshot → vision model (slow + expensive) | JSON model: fast, cheap, deterministic |
| Re-navigate on every workflow run | API replay: record once, execute via HTTP (no browser) |
| Black-box agent loop | Verify every step — observed state vs expected outcome |

---

## How it Works

```
┌───────────────────────────────────────────────────────────────────────┐
│  Your AI Agent  (Python / TypeScript / any LLM framework)             │
│                                                                       │
│  page = navigate("https://checkout.app")                              │
│  # → {"forms":[{"id":"checkout","purpose":"payment",                  │
│  #     "fields":[{"name":"card","type":"payment"},...]}]}             │
│                                                                       │
│  action({"type":"fill","form":"checkout","field":"email","value":"x"})│
│  result = run(session, "complete the purchase for $49/month plan")    │
└────────────────────┬──────────────────────────────────────────────────┘
                     │  HTTP REST  /  WebSocket  /  MCP
                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Semantic Runtime Layer                                               │
│                                                                       │
│  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │  Semantic Page   │  │  Action Resolver   │  │  API Replay      │  │
│  │  Model           │  │                    │  │  Engine          │  │
│  │  DOM → JSON      │  │  intent → action   │  │  HTTP replay,    │  │
│  │  forms, fields,  │  │  4-tier fallback   │  │  no browser      │  │
│  │  buttons, tables │  │  auto-healing      │  │  needed          │  │
│  └──────────────────┘  └────────────────────┘  └──────────────────┘  │
│                                                                       │
│  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │  LLM Agent Loop  │  │  Chrome Extension  │  │  MCP Server      │  │
│  │  ReAct, planner  │  │  Real browser,     │  │  Claude Desktop  │  │
│  │  HITL, job queue │  │  existing sessions │  │  native tool     │  │
│  └──────────────────┘  └────────────────────┘  └──────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Option 1 — One-click deploy on Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/Abhishekxdg/Agentic-browser)

### Option 2 — Docker

```bash
git clone https://github.com/Abhishekxdg/Agentic-browser
cd Agentic-browser
docker compose up
# → http://localhost:3001
```

### Option 3 — Local

```bash
git clone https://github.com/Abhishekxdg/Agentic-browser
cd Agentic-browser
bun install && bunx playwright install chromium && bun run start
```

---

## Use with Claude (MCP) — Zero code required

The fastest path. Claude controls the browser as a native tool.

```bash
claude mcp add agent-browser -- bun run /path/to/Agentic-browser/src/mcp/server.ts
```

Then tell Claude: *"Log into GitHub, find all open PRs assigned to me, and summarize them."*

[Full MCP setup →](docs/mcp-setup.md)

---

## Use with Python

```python
from agentbrowser import AgentBrowser

agent = AgentBrowser()

with agent.session() as sid:
    # Navigate — get semantic page model, not raw DOM
    page = agent.navigate(sid, "https://app.example.com")
    print(page["forms"])       # [{id:"login", purpose:"authentication", fields:[...]}]
    print(page["interactive"]) # [{label:"Sign in", type:"button"}, ...]

    # Act on meaning, not selectors
    agent.action(sid, {"type": "fill", "form": "login", "field": "email", "value": "me@x.com"})
    agent.action(sid, {"type": "press", "key": "Enter"})

    # Auto-login: configure once, fires automatically on login pages
    agent.configure_auth(sid, "me@x.com", "password", site="app.example.com")
    agent.navigate(sid, "https://app.example.com/login")  # auto-fills + submits

    # Autonomous agent loop — give it a goal
    result = agent.run(sid, "Export all invoices from Q1 2026 as CSV")
    print(result["steps"])      # every decision + action taken
    print(result["final_answer"])
```

---

## The API Replay Engine — No Browser Required

Record a workflow once. Replay it forever via pure HTTP calls — no Chrome, no DOM, no Playwright. Orders of magnitude faster and more reliable than re-navigating.

```python
# Step 1: Record once (human performs the workflow)
agent.start_recording("https://invoicing.app")
# → user manually submits an invoice in browser
agent.stop_recording("https://invoicing.app", "submit_invoice")

# Step 2: Replay forever (no browser needed)
result = agent.do("https://invoicing.app", "submit invoice for $1,200 to Acme Corp")
# → pure HTTP calls against the site's backend API
# → sub-second execution vs 10+ seconds with DOM
```

---

## Benchmark vs Playwright

Measured on 5 real sites, parallel execution.

```mermaid
xychart-beta
    title "Response time per site (ms) — bar=Playwright, line=Agent Browser"
    x-axis ["Example Domain", "HTTPBin Form", "Wikipedia", "Hacker News", "DuckDuckGo"]
    y-axis "Time (ms)" 0 --> 9000
    bar [1209, 2147, 4088, 2665, 3778]
    line [6310, 7560, 7131, 7514, 7353]
```

| | Playwright | Agent Browser |
|--|-----------|--------------|
| Pass rate | 4/5 | 4/5 |
| Avg time | 2777ms | 7174ms |
| Selector dependency | ❌ required | ✅ none |
| Semantic form fill | ❌ | ✅ |
| Auto-login | ❌ | ✅ |
| CAPTCHA solving | ❌ | ✅ |
| LLM agent loop | ❌ | ✅ |
| API replay | ❌ | ✅ |
| MCP native | ❌ | ✅ |

*Agent Browser is 2-3x slower at individual calls because it runs full semantic extraction on every page. The API replay engine (no browser) is 10-100x faster on recorded workflows.*

---

## vs Other Browser Agent Tools

| | Stagehand | Browser Use | Skyvern | **Agent Browser** |
|--|-----------|------------|---------|------------------|
| **Architecture** | Playwright + LLM recovery | Playwright + agent loop | Vision/OCR | Semantic runtime layer |
| **Page model** | DOM / a11y tree | Screenshots + DOM | Screenshots | Structured JSON |
| **Token cost per action** | High | High | Very high | Low |
| **Selector required** | Yes | Yes | No | **No** |
| **API replay** | ❌ | ❌ | ❌ | **✅ (unique)** |
| **MCP native** | ❌ | ❌ | ❌ | **✅** |
| **Real browser ext** | ❌ | ❌ | ❌ | **✅** |
| **Visual tasks (canvas)** | Medium | Medium | **✅ best** | Partial |
| **Self-hostable** | ✅ | ✅ | Partial | **✅** |
| **Open source** | ✅ | ✅ | Partial | **✅** |

**The key distinction:** every competitor optimizes the *agent* (smarter drivers). Agent Browser optimizes the *environment* (smarter roads). Agents built on a semantic runtime need less reasoning, fewer tokens, and fewer retries.

---

## What's Inside

```
src/agent-browser/    Semantic runtime: CDP bridge, page model, action resolver, server
src/layer2/           API replay engine: recorder, graph extractor, intent resolver
src/mcp/              MCP server (Claude Desktop / Claude Code)
extension/            Chrome extension (pre-installed, real browser sessions)
src/executor/         Execution engine: HTTP replay, error classification, caching
sdk/python/           Python client SDK
evals/                Benchmark suite (Playwright comparison, feasibility gate)
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_BROWSER_API_KEY` | `dev-key` | Change this in production |
| `GEMINI_API_KEY` | — | For LLM agent loop (Gemini) |
| `OPENAI_API_KEY` | — | For LLM agent loop (OpenAI) |
| `ANTHROPIC_API_KEY` | — | For LLM agent loop (Anthropic) |
| `MAX_SESSIONS` | `5` | Chrome pool size |
| `HEADLESS` | `true` | Set `false` to watch the browser |
| `CHROME_FLAGS` | — | Extra Chrome flags (`--no-sandbox` for cloud) |

---

## Documentation

| | |
|--|--|
| [Getting Started](docs/getting-started.md) | Install, first session, first action |
| [Page Model](docs/page-model.md) | The semantic JSON your agent reads |
| [Action Types](docs/action-types.md) | 30+ actions with examples |
| [API Reference](docs/api-reference.md) | Every endpoint documented |
| [Python SDK](docs/python-sdk.md) | SDK methods reference |
| [MCP Setup](docs/mcp-setup.md) | Use in Claude Desktop / Claude Code |
| [Chrome Extension](docs/extension.md) | Pre-installed, real browser sessions |
| [Examples](docs/examples.md) | Login, scrape, send email, LLM loop |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and fixes |
| [Roadmap](ROADMAP.md) | 8-phase plan — reliability to semantic OS |

---

> **License:** Personal & educational use only. Derivatives must be open source under the same license. Commercial use requires written permission — [contact us](mailto:myuvarajgowda@gmail.com). See [LICENSE](LICENSE).
