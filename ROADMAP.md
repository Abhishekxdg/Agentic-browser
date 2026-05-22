# Agent Browser — Roadmap

**Vision:** Evolve from semantic execution tool → operating system for autonomous web agents.

**Current state:** Semantic extraction ✅ · Action execution ✅ · Sessions ✅ · MCP ✅ · Chrome extension ✅ · API replay ✅ · LLM agent loop ✅ · Job queue ✅ · Chrome pool ✅

---

## Phase 1 — Reliability Layer
*Target: v0.3 · Est: 3-4 weeks*

Without this, agents remain demos. Every feature in later phases depends on it.

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 1.1 | **Action Confidence Scoring** | Every action returns `{confidence: 0.94, strategy: "semantic_label_match"}`. Drives retry decisions and fallback selection. | ✅ |
| 1.2 | **Verification Engine** | After every action: compare expected outcome vs observed state (URL changed? modal appeared? cookie set?). Becomes the execution validator. | ✅ |
| 1.3 | **Recovery Engine** | Structured failure handling: semantic → aria → text → nearest element → vision → escalate. Backtracking. Dead-end detection. Rollback. | ✅ |
| 1.4 | **Deterministic Wait System** | Replace fixed sleeps with: network idle, semantic state wait (element appears), UI stabilization, mutation quiet period. | ✅ |
| 1.5 | **Action Trace Recorder** | Record everything: execution timeline, screenshots at each step, semantic snapshots, network traces, state transitions. Feeds debugging + evals + training. | ✅ |

**Exit criteria:** agent can complete a 10-step login + form fill workflow with >90% reliability across 3 different sites without human intervention.

---

## Phase 2 — Live Semantic Runtime
*Target: v0.4 · Est: 3-4 weeks*

Current extraction is snapshot-based. Agents need incremental awareness.

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 2.1 | **Live Semantic Graph** | Mutation → semantic diff → graph update. Like React reconciliation but for semantic cognition. No full-page re-extract on every action. | ✅ |
| 2.2 | **Event Awareness** | Track: navigation, modal opens, AJAX updates, WebSocket changes, lazy loading, infinite scroll. Agent knows what changed without re-scanning. | ✅ |
| 2.3 | **Accessibility Tree Integration** | Use ARIA roles + accessibility labels + semantic hierarchy as primary extraction layer. Often more stable than DOM. | ✅ |
| 2.4 | **Cross-Page Context Graph** | Pages connect semantically (Amazon product ↔ cart ↔ checkout ↔ payment). Becomes workflow memory. | ✅ |
| 2.5 | **Semantic Web Cache** | Cache semantic understanding of visited pages. `github.com/pulls` already understood → skip extraction. Massive speed improvement. | ✅ |

**Exit criteria:** semantic graph updates in <100ms for typical SPA mutations. Full page re-extract only on navigation.

---

## Phase 3 — Vision Layer
*Target: v0.5 · Est: 2-3 weeks*

DOM-only systems hit limits on canvas, WebGL, streamed apps, shadow DOM edge cases.

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 3.1 | **Multimodal Perception** | Screenshot → LLM vision for: canvas apps, WebGL UIs, streamed content, OCR on images. Fallback when DOM fails. | ⬜ partial (basic vision exists) |
| 3.2 | **Visual Grounding** | Agent understands "top-right blue button". Coordinate mapping + visual segmentation + semantic-to-visual alignment. | ⬜ |
| 3.3 | **Vision-Semantic Fusion** | Semantic extraction primary, vision fills gaps. Not screenshot-only (slow + expensive) but DOM + screenshot hybrid. | ⬜ |

**Exit criteria:** agent completes tasks on 3 canvas/WebGL apps that fail DOM-only extraction.

---

## Phase 4 — Workflow Intelligence
*The moat.*
*Target: v0.6 · Est: 4-6 weeks*

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 4.1 | **Workflow Graph Engine** | Represent workflows as DAGs: Login → Navigate → Search → Filter → Purchase → Verify. Enables retries, resumability, optimization. | ⬜ |
| 4.2 | **Planner / Executor Separation** | Separate: Planner (what to do) · Executor (how to do it) · Verifier (did it work) · Recovery (what when it fails). Massively improves reliability. | ⬜ partial (task-planner.ts is close) |
| 4.3 | **Skill System** | Reusable semantic workflows: `gmail.send_email`, `github.merge_pr`, `shopify.fulfill_order`. Shareable, composable. | ⬜ partial (Layer 2 graphs) |
| 4.4 | **Site Intelligence Database** | Per-site store: known workflows, semantic mappings, failure patterns, auth flows, interaction heuristics. Gets smarter with every run. | ⬜ partial (site-memory.ts) |
| 4.5 | **Declarative Workflow DSL** | YAML/JSON workflow definitions. Agent-native automation language. No code required for common workflows. | ✅ |

**Exit criteria:** new developer can automate a 5-step Salesforce workflow in under 10 minutes by describing intent, not writing selectors.

---

## Phase 5 — Developer Platform
*Target: v0.7 · Est: 3-4 weeks*

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 5.1 | **TypeScript SDK** | npm package. Most AI frameworks (LangChain, Vercel AI SDK, Mastra) are TS-first. Python-only blocks 50% of target market. | ⬜ |
| 5.2 | **Eval Framework** | Site benchmarks · reliability scores · action success % · latency tracking · hallucination rate. Your benchmark moat. | ⬜ partial (3 eval scripts) |
| 5.3 | **Sandbox Replay Environment** | Replay workflows, failures, user sessions. Needed for: debugging, training data, eval regression. | ⬜ |
| 5.4 | **Browser State Snapshots** | Checkpoint: cookies + storage + tabs + semantic graph + network state. Save game for browser agents. Resume exactly where left off. | ⬜ partial (cookie save/load) |
| 5.5 | **Go SDK** | For high-performance agent backends. | ⬜ |

**Exit criteria:** TypeScript SDK published on npm. Developer builds a working agent in <20 lines of TypeScript.

---

## Phase 6 — Enterprise Features
*Target: v1.0 · Est: 4-6 weeks*

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 6.1 | **Secret Vault** | Encrypted credential storage: API keys, cookies, tokens, passwords. Per-org, per-user isolation. | ⬜ partial (cookie profiles) |
| 6.2 | **Audit Logs** | Every action timestamped + screenshotted. Exportable. Required for enterprise. | ⬜ |
| 6.3 | **Human Approval Layer** | Before purchases, deletions, money movement: pause + notify + await approval. More granular than current HITL. | ✅ partial (HITL exists) |
| 6.4 | **RBAC / Permissions** | Agent scopes: can read Gmail, cannot send, can draft only. Per-agent permission sets. | ✅ |
| 6.5 | **Postgres Backend** | Replace JSON file storage (graphs, jobs, memory) with Postgres. Required for multi-instance and scale. | ⬜ |

**Exit criteria:** pass a security review. Enterprise customer can deploy with confidence that one agent cannot access another org's data.

---

## Phase 7 — Scale
*Target: v1.1 · Est: 4-6 weeks*

| # | Feature | What it does | Status |
|---|---------|-------------|--------|
| 7.1 | **Session Hibernation** | Suspend idle sessions: serialize state → restore later. Huge infra savings vs keeping Chrome alive 24/7. | ⬜ |
| 7.2 | **Distributed Browser Pool** | Run browsers across machines/containers/regions. Kubernetes operator for horizontal scaling. | ⬜ partial (chrome-pool.ts is single-machine) |
| 7.3 | **Redis Job Queue** | Replace in-memory + JSON job queue with Redis/Bull. Multi-instance safe. Job persistence across deploys. | ⬜ |
| 7.4 | **GPU Perception Workers** | Separate worker pool for: OCR, multimodal parsing, visual segmentation. Don't block browser pool. | ⬜ |

---

## Phase 8 — Agent-Native Future
*Target: v2.0*

| # | Feature | What it does |
|---|---------|-------------|
| 8.1 | **Multi-Agent Coordination** | Planner → Research Agent → Browser Executor → Verifier Agent. Specialist agents collaborate on complex tasks. |
| 8.2 | **Long-Horizon Tasks** | Tasks running hours or days. Queues + resumability + checkpoints. Not just 20-step loops. |
| 8.3 | **Site Skills Marketplace** | Pre-recorded graphs for Zoho, GitHub, Salesforce, QuickBooks. Community-contributed. Rated by reliability. Revenue model. |
| 8.4 | **Semantic Cognition** | Beyond execution: understand workflows, adapt strategies, predict failures, reason about intent. The OS layer. |

---

## Strategic Priority Matrix

| Priority | Feature | Leverage | Effort |
|----------|---------|---------|--------|
| 🔴 1 | Reliability engine (confidence + verification + recovery) | Unblocks all agents from demo → production | M |
| 🔴 2 | Action trace recorder | Debugging, evals, training data in one shot | S |
| 🟠 3 | Live semantic graph | 10x faster agent loops, less token waste | L |
| 🟠 4 | TypeScript SDK | Unblocks 50% of target developers | S |
| 🟠 5 | Site intelligence database (deepen) | Compound value — smarter every run | M |
| 🟡 6 | Workflow graph engine + planner/executor split | Foundation for all complex automation | L |
| 🟡 7 | Eval framework (deepen) | Benchmark moat, sales evidence | M |
| 🟡 8 | Accessibility tree integration | More reliable than DOM on enterprise apps | M |
| 🟢 9 | Multi-agent coordination | After reliability is solid | XL |
| 🟢 10 | Distributed pool + Postgres | After first 10 paying customers | XL |

---

## The Transition

```
TODAY                          v1.0                        v2.0
─────────────────────          ──────────────────────      ────────────────────────
Semantic execution tool   →    Reliable workflow engine → OS for autonomous agents

"Tell me what to click"        "Here's your goal,          "Understand what I need,
                                I'll verify each step"      adapt, and get it done"
```

The gap between today and v1.0 is **reliability**. Everything else compounds on top of it.
