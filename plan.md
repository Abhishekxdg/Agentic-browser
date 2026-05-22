Agent Browser Infrastructure is a platform that lets AI agents reliably use websites like humans, but through stable machine-friendly APIs instead of fragile browser automation scripts. Today, agents struggle with changing UIs, logins, forms, CAPTCHAs, and broken selectors. This platform acts like an operating system for the web: managing browser sessions, authentication, semantic page understanding, retries, workflow memory, and self-healing automation. Developers can give agents high-level intents like "book appointment" or "submit invoice" instead of manual clicks and selectors. The infrastructure handles execution reliably at scale. It becomes foundational infrastructure for autonomous agents operating across legacy websites and enterprise systems.

## Ship Order Decision (2026-05-22)

**Approach A selected:** Ship Semantic Browser (`src/agent-browser/`) as v0.1 first. Get first external user before continuing T1-T6 (API replay platform).

The semantic browser is working today — demonstrated sending a real email via Gemini agent. Three blockers must be fixed before v0.1 ships to an external user.

## Implementation Tasks (CEO Review — v0.1 Ship Blockers)

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — sdk/python — Rewrite Python SDK to match server API
  - Surfaced by: D3 — SDK calls /v1/auth (501) and port 3000; server runs on 3001 with /session routes
  - Files: `sdk/python/agentbrowser/client.py`
  - Verify: `agent.create_session(); agent.navigate(session, "https://example.com")` returns page model

- [ ] **T2 (P1, human: ~10min / CC: ~2min)** — src/agent-browser — Replace hardcoded CHROMIUM_PATH
  - Surfaced by: D4 — `/Users/abhishek/.../chromium-1223/` hardcoded; breaks on any other machine
  - Files: `src/agent-browser/cdp-bridge.ts`
  - Verify: `CHROMIUM_PATH` env var unset; `POST /session` launches Chrome on a fresh machine

- [ ] **T3 (P1, human: ~5min / CC: ~1min)** — README.md + cdp-bridge — Add playwright install step + improve error
  - Surfaced by: D5 — `bun install` does not install Chromium binary; launch fails silently
  - Files: `README.md`, `src/agent-browser/cdp-bridge.ts`
  - Verify: Chrome not installed → error says "Chromium not found. Run: bunx playwright install chromium"

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (PLAN) | 3 P1 blockers, 0 unresolved |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 10 issues, 3 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** 0 decisions outstanding
- **VERDICT:** CEO + ENG CLEARED — Fix T1-T3 (above) before handing v0.1 to first external user. T4-T6 (API replay platform) deferred until first user validates semantic browser.
