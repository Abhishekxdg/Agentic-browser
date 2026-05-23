<div align="center">

# Sound Browser

### Semantic Orchestration Unified Network Discovery

**A semantic runtime for autonomous web agents.**

Turn messy web pages into structured intent graphs. Run agents on meaning, not brittle selectors.

[![npm](https://img.shields.io/npm/v/sound-browser?label=npm%20sound-browser)](https://www.npmjs.com/package/sound-browser)
[![License](https://img.shields.io/badge/license-Non--Commercial-blue)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Roadmap](https://img.shields.io/badge/roadmap-v2.0-green)](ROADMAP.md)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/Abhishekxdg/Sound-Browser)

</div>

---

## What Is Sound Browser?

Most browser agents feed raw DOM, screenshots, or accessibility dumps into an LLM and hope the model can infer what matters. That burns tokens, breaks on redesigns, and turns every click into a tiny research project.

Sound Browser takes the opposite path:

```text
Web page
  -> semantic runtime
  -> structured page model
  -> verified actions
  -> replayable workflows
```

Your agent sees forms, fields, buttons, dialogs, tables, events, page context, and workflow state as JSON. It acts on intent:

```ts
await browser.action(sessionId, {
  type: "fill",
  form: "login",
  field: "email",
  value: "me@example.com",
});

await browser.action(sessionId, {
  type: "click",
  target: "Sign in",
});
```

No CSS selector treasure hunt. No giant DOM prompt. No screenshot-first tax.

---

## Highlights

| Capability | Status |
|---|---|
| Semantic page extraction | ✅ Forms, fields, links, tables, dialogs, interactive controls |
| Semantic action execution | ✅ Click, fill, type, press, scroll, tabs, cookies, storage, files |
| Verification + recovery | ✅ Confidence, strategy, post-action validation, recovery paths |
| Live semantic runtime | ✅ Mutation diffs, event awareness, semantic cache, context graph |
| Vision fallback | ✅ Screenshot-to-actions, visual grounding, DOM + vision fusion |
| API replay engine | ✅ Record workflows, infer API graph, execute via HTTP |
| Autonomous agent loop | ✅ ReAct loop, planner/executor split, job queue, HITL |
| Workflow DSL | ✅ YAML/JSON workflows with parameters and dependencies |
| Developer platform | ✅ Published TypeScript SDK, Go SDK, evals, replay, snapshots |
| Enterprise controls | ✅ Vault, audit chain, RBAC, Postgres backends |
| MCP + Chrome extension | ✅ Claude-compatible tools and real-browser extension bridge |

---

## Install

### Server

```bash
git clone https://github.com/Abhishekxdg/Sound-Browser
cd Sound-Browser
bun install
bunx playwright install chromium
SOUND_BROWSER_ALLOW_DEV_KEY=true bun run start
```

Server runs at:

```text
http://localhost:3001
```

Health check:

```bash
curl http://localhost:3001/health
```

### Docker

```bash
SOUND_BROWSER_API_KEY=change-me docker compose up
```

### Postgres Profile

```bash
docker compose --profile postgres up postgres
```

Then:

```bash
DATABASE_URL=postgres://sound:sound@localhost:5432/sound_browser \
SOUND_JOB_BACKEND=postgres \
SOUND_GRAPH_BACKEND=postgres \
SOUND_MEMORY_BACKEND=postgres \
SOUND_CACHE_BACKEND=postgres \
SOUND_AUDIT_BACKEND=postgres \
bun run db:init
```

---

## TypeScript SDK

Published on npm:

```bash
npm install sound-browser
```

```ts
import { SoundBrowser } from "sound-browser";

const browser = new SoundBrowser({
  apiKey: process.env.SOUND_BROWSER_API_KEY ?? "dev-key",
});

await browser.session(async (sessionId) => {
  const page = await browser.navigate(sessionId, "https://example.com");
  console.log(page.page.title);

  await browser.action(sessionId, {
    type: "click_text",
    text: "More information",
  });
});
```

Autonomous agent in under 20 lines:

```ts
import { SoundBrowser } from "sound-browser";

const browser = new SoundBrowser();

const result = await browser.session(async (sessionId) => {
  await browser.navigate(sessionId, "https://app.example.com");
  return browser.run(sessionId, "Export all invoices from Q1 as CSV");
});

console.log(result.final_answer ?? result.error);
```

SDK source: [sdk/typescript](sdk/typescript)

---

## Python SDK

```bash
pip install "git+https://github.com/Abhishekxdg/Sound-Browser.git#subdirectory=sdk/python"
```

```python
from agentbrowser import SoundBrowser

agent = SoundBrowser()

with agent.session() as sid:
    page = agent.navigate(sid, "https://example.com")
    print(page["page"]["title"])

    agent.action(sid, {"type": "click_text", "text": "More information"})
```

SDK source: [sdk/python](sdk/python)

---

## Go SDK

Dependency-free Go client for high-performance agent backends:

```go
package main

import (
    "context"
    "fmt"

    soundbrowser "github.com/Abhishekxdg/Sound-Browser/sdk/go"
)

func main() {
    client := soundbrowser.New()

    err := client.WithSession(context.Background(), soundbrowser.SessionOptions{}, func(sessionID string) error {
        page, err := client.Navigate(context.Background(), sessionID, "https://example.com")
        if err != nil {
            return err
        }
        fmt.Println(page.Page.Title)
        return nil
    })
    if err != nil {
        panic(err)
    }
}
```

SDK source: [sdk/go](sdk/go)

Note: Go SDK is built in-tree. `go test ./...` still needs a local Go toolchain to verify in this workspace.

---

## MCP: Use From Claude

Sound Browser ships an MCP server for Claude Desktop / Claude Code:

```bash
claude mcp add sound-browser -- bun run /path/to/Sound-Browser/src/mcp/server.ts
```

Then ask:

```text
Open GitHub, find open PRs assigned to me, and summarize them.
```

Full guide: [docs/mcp-setup.md](docs/mcp-setup.md)

---

## Architecture

```mermaid
flowchart TB
    Agent["AI Agent / App / MCP Client"] --> API["Sound Browser REST + WebSocket API"]
    API --> Session["Browser Session Manager"]
    Session --> CDP["Chrome DevTools Bridge"]
    CDP --> Page["Semantic Page Extractor"]
    Page --> Graph["Live Semantic Graph"]
    Graph --> Action["Action Resolver"]
    Action --> Verify["Verifier + Recovery"]
    Verify --> Audit["Audit + Trace Recorder"]

    API --> Jobs["Async Job Queue"]
    API --> DSL["Workflow DSL Compiler"]
    API --> Skills["Skill System"]
    API --> Replay["API Replay Engine"]
    Replay --> GraphStore["Recorded API Graph Store"]

    API --> Vault["Encrypted Vault"]
    API --> RBAC["RBAC Policies"]
    API --> Snapshots["Browser State Snapshots"]
    API --> Evals["Eval + Replay Harness"]

    Jobs --> Postgres["Optional Postgres Backends"]
    GraphStore --> Postgres
    Audit --> Postgres
    Snapshots --> Files["Local State Files"]
```

---

## Semantic Page Model

Instead of giving your agent raw DOM, Sound Browser returns structured JSON:

```json
{
  "page": {
    "url": "https://app.example.com/login",
    "title": "Sign in",
    "viewport": { "width": 1280, "height": 720 }
  },
  "forms": [
    {
      "id": "login",
      "purpose": "authentication",
      "fields": [
        { "name": "email", "type": "email", "label": "Email" },
        { "name": "password", "type": "password", "label": "Password" }
      ],
      "actions": [
        { "type": "submit", "label": "Sign in" }
      ]
    }
  ],
  "dialogs": [],
  "interactive": [],
  "tables": []
}
```

Docs: [docs/page-model.md](docs/page-model.md)

---

## Action Execution

Every action goes through a reliability envelope:

1. Capture pre-action state
2. Execute semantic action
3. Refresh or patch semantic graph
4. Verify expected outcome
5. Record trace and audit entry
6. Recover or escalate if needed

Example response:

```json
{
  "success": true,
  "confidence": 0.95,
  "strategy": "semantic_form_field",
  "verification": {
    "verified": true,
    "evidence": "Field \"email\" has value",
    "confidence": 0.95
  }
}
```

Supported action families:

- Navigation: `navigate`, `history`, tabs
- Interaction: `click`, `double_click`, `right_click`, `hover`, `press`
- Forms: `fill`, `select`, `type_text`, file upload
- Waiting: `wait`, `wait_for`, network idle, semantic state
- Extraction: text, screenshots, cookies, storage, iframes
- Browser state: cookies, localStorage, sessionStorage, dialogs

Docs: [docs/action-types.md](docs/action-types.md)

---

## Live Runtime

Sound Browser is not just snapshot extraction.

- **Live semantic graph:** DOM mutation to semantic diff
- **Event awareness:** navigation, modal opens, AJAX, WebSocket, toast, CAPTCHA
- **Cross-page context:** product -> cart -> checkout -> payment
- **Semantic cache:** avoid re-extracting known pages
- **Stream API:** WebSocket page mutations and action results

```bash
curl http://localhost:3001/session/$SID/graph/diffs?since=0 \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
```

---

## Browser State Snapshots

Checkpoint browser state for resumable agents:

- Tabs
- Cookies
- localStorage and sessionStorage
- Semantic page model
- Live semantic graph diffs
- Cross-page context graph
- Network event state

```bash
curl -X POST http://localhost:3001/session/$SID/state/save \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profile":"checkout-state"}'

curl -X POST http://localhost:3001/session/$SID/state/load \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profile":"checkout-state"}'
```

Snapshots live in `~/.sound-browser/snapshots/`.

---

## API Replay Engine

Record a browser workflow once. Sound Browser captures backend calls, builds an API graph, and can later execute the same intent through HTTP without a browser.

```bash
curl -X POST http://localhost:3001/record/start \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"site_url":"https://invoicing.example","org_id":"default"}'

curl -X POST http://localhost:3001/record/stop \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"site_url":"https://invoicing.example","workflow_name":"submit_invoice"}'

curl -X POST http://localhost:3001/do \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"site":"https://invoicing.example","intent":"submit invoice for Acme"}'
```

This is the fast path: browser for discovery, HTTP replay for repeat execution.

---

## Eval + Replay Platform

Measure agent workflows as first-class artifacts:

- Reliability score
- Action success rate
- Latency
- Hallucination-like resolution failures
- Per-check results
- Replay from action list or saved trace

```ts
const result = await browser.runEval([
  {
    name: "example smoke",
    actions: [
      { type: "navigate", url: "https://example.com" },
      { type: "wait", condition: "network.idle", ms: 1000 }
    ],
    checks: [
      { name: "title", expression: "document.title.includes('Example')" }
    ]
  }
]);

console.log(result.summary);
```

CLI smoke:

```bash
bun run eval:platform
```

Docs: [docs/developer-platform.md](docs/developer-platform.md)

---

## Autonomous Jobs

Submit long-running tasks and poll or receive webhook callbacks:

```bash
curl -X POST http://localhost:3001/jobs \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "site_url": "https://example.com",
    "goal": "Find the contact page",
    "max_steps": 10
  }'

curl http://localhost:3001/jobs/$JOB_ID \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
```

Jobs support:

- `queued`, `running`, `done`, `failed`, `cancelled`, `waiting_hitl`
- Human-in-the-loop resolution
- Optional Postgres persistence
- Optional webhook on completion

---

## Workflow DSL

Define browser automations in YAML:

```yaml
name: github_create_issue
site: github.com
parameters:
  - name: repo
    type: string
    required: true
  - name: title
    type: string
    required: true

steps:
  - id: navigate
    type: navigate
    url: "https://github.com/{{repo}}/issues/new"

  - id: fill_title
    type: fill
    selector: "#issue_title"
    value: "{{title}}"
    depends_on: [navigate]

  - id: submit
    type: click
    selector: 'button[type="submit"]'
    depends_on: [fill_title]
    checkpoint: true
```

```bash
curl -X POST http://localhost:3001/dsl \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  --data-binary @examples/workflows/github-create-issue.yaml
```

DSL supports `navigate`, `fill`, `click`, `press`, `wait`, `screenshot`, `evaluate_js`, `verify`, `branch`, `skill`, and `loop`.

---

## Skills + Site Intelligence

Skills are reusable semantic workflows:

- Built-in skills
- Custom saved skills
- P2P-discovered skills
- Reputation tracking
- Site-specific memory and corrections

```bash
curl http://localhost:3001/skills?site=github.com \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"

curl -X POST http://localhost:3001/skills/github.create_issue/run \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"sess_abc123","params":{"title":"Bug report"}}'
```

Site memory tracks:

- Corrections
- Timing hints
- Reliable selectors
- Auth patterns
- CAPTCHA patterns

---

## Vision Layer

For canvas, WebGL, screenshots, shadow DOM edge cases, or missing semantic anchors:

```bash
curl -X POST http://localhost:3001/session/$SID/vision \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"intent":"click the blue button in the top right"}'
```

Vision is fallback, not the default. Sound Browser stays semantic-first and uses vision to fill gaps.

---

## Enterprise Controls

### Credential Vault

Encrypted credentials, API keys, passwords, and TOTP secrets:

```bash
export SOUND_VAULT_KEY="use-a-long-random-secret"

curl -X POST http://localhost:3001/vault/my-org \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "site": "github.com",
    "username": "me@example.com",
    "password": "stored-encrypted",
    "totp_secret": "BASE32SECRET"
  }'
```

Raw passwords and TOTP secrets are never returned by read endpoints.

### Audit Logs

Tamper-evident hash chain:

```bash
curl http://localhost:3001/audit/default \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"

curl "http://localhost:3001/audit/default/export?format=csv" \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"

curl http://localhost:3001/audit/default/verify \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
```

### RBAC

Agent permissions with allow, deny, site scoping, presets, and rate limits:

```bash
curl -X POST http://localhost:3001/policies/my-org \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"reader","preset":"read-only"}'

curl -X POST http://localhost:3001/policies/my-org/reader/check \
  -H "Authorization: Bearer $SOUND_BROWSER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"permission":"fill","site":"https://github.com"}'
```

Presets: `read-only`, `read-and-click`, `form-fill`, `full-access`.

---

## Postgres Backends

Local JSON files are the default. Postgres can back multi-instance deployment for:

- Jobs
- API graphs
- Site memory
- Semantic cache
- Audit logs

Check active backends:

```bash
curl http://localhost:3001/jobs/backend -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
curl http://localhost:3001/graphs/backend -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
curl http://localhost:3001/memory/backend -H "Authorization: Bearer $SOUND_BROWSER_API_KEY"
```

Docs: [docs/postgres-backend.md](docs/postgres-backend.md)

---

## API Surface

| Area | Endpoints |
|---|---|
| Sessions | `POST /session`, `GET /session`, `DELETE /session/:id` |
| Page | `POST /session/:id/navigate`, `GET /session/:id/page`, `GET /session/:id/screenshot` |
| Actions | `POST /session/:id/action`, `POST /session/:id/actions`, `WS /session/:id/stream` |
| Browser state | cookies, storage, tabs, dialogs, history, snapshots |
| Agent loop | `POST /session/:id/run`, `POST /jobs`, `GET /jobs/:id` |
| Replay | `POST /record/start`, `POST /record/stop`, `POST /do` |
| Eval | `POST /eval/run`, `POST /replay/actions`, `POST /replay/trace` |
| Memory | `GET /memory`, `GET /memory/:host`, `DELETE /memory/:host` |
| Security | `/vault`, `/audit`, `/policies` |
| Workflows | `/skills`, `/dsl`, `/workflows` |

Full reference: [docs/api-reference.md](docs/api-reference.md)

---

## Project Layout

```text
src/agent-browser/     semantic runtime, CDP bridge, action resolver, agent loop
src/layer2/            API replay engine, graph store, site memory
src/executor/          HTTP execution engine, cache, error classifier
src/mcp/               MCP server and cookie store
src/storage/           Postgres schema initialization
sdk/typescript/        published npm SDK: sound-browser
sdk/python/            Python SDK
sdk/go/                Go SDK
extension/             Chrome extension bridge
evals/                 benchmarks, feasibility gate, platform smoke
examples/workflows/    YAML workflow examples
docs/                  API, SDK, platform, Postgres, troubleshooting
```

---

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `SOUND_BROWSER_API_KEY` | required | Bearer token for HTTP API |
| `SOUND_BROWSER_ALLOW_DEV_KEY` | `false` | Use `dev-key` locally |
| `SOUND_BROWSER_PORT` | `3001` | Server port |
| `SOUND_BROWSER_ENABLE_EVALUATE` | `false` | Enables raw page JS evaluation |
| `SOUND_BROWSER_URL` | `http://localhost:3001` | SDK server URL |
| `SOUND_VAULT_KEY` | none | Encryption key for vault |
| `DATABASE_URL` / `SOUND_DATABASE_URL` | none | Postgres connection string |
| `SOUND_JOB_BACKEND` | file or auto | Set `postgres` for job storage |
| `SOUND_GRAPH_BACKEND` | file or auto | Set `postgres` for graph storage |
| `SOUND_MEMORY_BACKEND` | file or auto | Set `postgres` for site memory |
| `SOUND_CACHE_BACKEND` | file | Set `postgres` for semantic cache |
| `SOUND_AUDIT_BACKEND` | file | Set `postgres` for audit logs |
| `GEMINI_API_KEY` | none | Gemini agent loop / vision |
| `OPENAI_API_KEY` | none | OpenAI agent loop / vision |
| `ANTHROPIC_API_KEY` | none | Anthropic eval / LLM use |
| `CAPTCHA_API_KEY` | none | CAPTCHA resolver service key |
| `MAX_SESSIONS` | `5` | Chrome pool size |
| `HEADLESS` | `true` | Set `false` to watch Chrome |
| `CHROME_FLAGS` | none | Extra Chrome flags |
| `AGENT_BROWSER_*` | compatibility | Legacy env aliases |

---

## Verification

Latest local verification in this workspace:

```bash
bun test
# 90 pass, 0 fail

bunx tsc --noEmit
# pass

bun run eval:platform
# pass, reliability_score: 1, action_success_rate: 1

cd sdk/typescript && npm pack --dry-run
# pass, sound-browser@0.7.1
```

Pending environment-specific checks:

- `go test ./...` in `sdk/go` requires Go toolchain
- Postgres live path requires running database, then `bun run db:init`

---

## Documentation

| Guide | What it covers |
|---|---|
| [Getting Started](docs/getting-started.md) | Install, first session, first action |
| [API Reference](docs/api-reference.md) | REST endpoints |
| [Page Model](docs/page-model.md) | Semantic JSON schema |
| [Action Types](docs/action-types.md) | Browser action catalog |
| [Developer Platform](docs/developer-platform.md) | Eval and replay APIs |
| [Postgres Backend](docs/postgres-backend.md) | Multi-instance persistence |
| [Python SDK](docs/python-sdk.md) | Python client |
| [MCP Setup](docs/mcp-setup.md) | Claude Desktop / Claude Code |
| [Chrome Extension](docs/extension.md) | Extension bridge |
| [Examples](docs/examples.md) | Common automations |
| [Troubleshooting](docs/troubleshooting.md) | Fixes and diagnostics |
| [Roadmap](ROADMAP.md) | Semantic execution tool to agent OS |

---

## Roadmap Snapshot

Completed:

- Phase 1: reliability layer
- Phase 2: live semantic runtime
- Phase 3: vision layer
- Phase 4: workflow intelligence
- Phase 5: developer platform
- Phase 6.5: Postgres backend

Next:

- Session hibernation
- Distributed browser pool
- Multi-instance job execution
- GPU perception workers
- Multi-agent coordination

Full roadmap: [ROADMAP.md](ROADMAP.md)

---

## License

Personal, educational, and non-commercial use only. Derivatives must remain open source under the same license. Commercial use requires written permission.

See [LICENSE](LICENSE).
