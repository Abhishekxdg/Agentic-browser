# Monetization Model — Hidden P2P + Tiered Value

## Core Insight

P2P skill sharing is **not the product**. It is the **free data flywheel** that makes the paid tiers irresistible.

Every agent run makes the network smarter. Every discovered workflow makes the platform more valuable. The free tier spreads the network. The paid tiers extract value from it.

---

## Pricing Tiers

| Feature | Free | Pro ($49/mo) | Enterprise ($499+/mo) |
|---------|------|-------------|----------------------|
| **P2P Discovery** | ✅ Public DHT | ✅ Priority lookups | ✅ Private org-only ring |
| **Browser Execution** | ✅ | ✅ | ✅ |
| **API Replay Engine** | ❌ (browser only) | ✅ 10-100x faster | ✅ + custom replay endpoints |
| **Skill Sources** | builtin + discovered | + verified marketplace | + premium + custom governance |
| **Support** | Community | Email | Dedicated Slack + phone |
| **RBAC on Skills** | ❌ | ❌ | ✅ Whitelist / blacklist / approval queue |
| **Audit Trail** | ❌ | Basic | Full provenance (who discovered what, when) |
| **On-Premise** | ❌ | ❌ | ✅ Docker / Kubernetes deploy |

### Free Tier — The Flywheel

- **Goal:** Maximum adoption. Every user is a node in the P2P network.
- **What they get:** Automatic skill discovery, browser-based execution, all community P2P skills.
- **Limitation:** No API replay. A Zoho invoice workflow takes 15 seconds in a browser instead of 300ms via HTTP replay.
- **Conversion trigger:** "This workflow works, but it's slow. Upgrade to Pro for instant replay."

### Pro Tier — The Speed Layer

- **Goal:** Power users and small teams who value time.
- **What they get:** Everything in Free + API Replay engine + priority P2P lookups + verified marketplace skills.
- **Key value prop:** A discovered skill is a browser workflow. A Pro skill is an HTTP sequence. Same intent, 50x faster.
- **Conversion trigger:** "Your team is running 200 workflows/day. API replay saves 40 hours/month."

### Enterprise Tier — The Control Layer

- **Goal:** Organizations that need governance, privacy, and support.
- **What they get:** Private P2P ring (skills only shared within the org), skill approval workflows, full audit trail, on-premise deployment.
- **Key value prop:** "Your Zoho workflows never leave your network. But you still benefit from the public network's discovery intelligence."
- **Pricing:** Per-seat or per-workflow-execution. Custom contracts.

---

## How P2P Is Hidden

Users never see "P2P." They never configure it. It is an implementation detail.

```bash
# What the user types
$ curl http://localhost:3001/skills?site=zoho.com
{"skills": [{"name": "zoho.create_invoice", "source": "discovered", "reliability": 0.94}]}

# What happens behind the scenes
1. Node queries local cache — miss
2. Node broadcasts DHT query for "zoho.com" skills
3. 3 peers respond with announcements
4. Node downloads most reliable candidate
5. Node verifies hash, replays workflow locally
6. Skill saved as "discovered" in local store
7. User sees it in the list
```

No UI for "join network." No "share skills" toggle. It just works.

---

## The Three Revenue Levers

### 1. Speed (API Replay)

The P2P network shares **browser workflows** (semantic actions, selectors, page transitions). These are free.

The **API replay sequences** (HTTP calls that bypass the browser entirely) are Pro+. Same skill, different execution mode.

| Execution Mode | Speed | Cost to Run | Tier Required |
|---|---|---|---|
| Browser (semantic actions) | 10-15s | Chrome + Playwright | Free |
| API Replay (HTTP calls) | 200-500ms | No browser | Pro+ |

This is the primary conversion driver. Free users feel the slowness every time they run a discovered workflow.

### 2. Trust (Verified Marketplace)

Discovered skills work most of the time. Verified skills work 99%+ of the time, with support if they break.

| Source | Reliability | Updates | Support |
|---|---|---|---|
| Discovered (P2P) | 70-90% | None | Community |
| Verified (Marketplace) | 95-99% | Automatic | Email |
| Premium (Marketplace) | 99%+ | Priority + SLA | Dedicated |

Verified skills cost $9-29 one-time or $9-29/mo. Premium skills cost $49-199/mo.

### 3. Governance (Enterprise)

Enterprises cannot let shadow automation run wild. They need:

- **Skill approval queues:** Every P2P-discovered skill sits in a queue until an admin approves it.
- **Blacklist/whitelist:** "No skills that touch the production database."
- **Audit trail:** "Who approved this Zoho skill, and when did it last run?"
- **Private ring:** Skills discovered by one department auto-share with the whole org, but never leak outside.

This is the stickiest tier. Once an enterprise has 50 agents running on Sound Browser, migrating away is painful.

---

## Unit Economics

### Free Tier

- **Revenue:** $0
- **Cost:** Chrome instances, P2P bandwidth, support (community)
- **Value:** Network effects, word-of-mouth, data for improving verified skills

### Pro Tier ($49/mo)

- **Revenue:** $49/user/month
- **Cost:** Minimal (API replay is cheaper than browser execution)
- **Margin:** ~85%
- **LTV:** $588/year per user

### Enterprise Tier ($499+/mo)

- **Revenue:** $499-5,000+/mo per org
- **Cost:** Support, custom engineering, on-premise packaging
- **Margin:** ~70%
- **LTV:** $15,000-100,000+/year per org

### Marketplace (one-time + recurring)

- **Revenue:** 30% take on verified/premium skill sales
- **Cost:** Curation, testing, documentation
- **Margin:** ~60%
- **LTV:** Increases with every new skill published

---

## Competitive Moat

1. **Data Network Effects:** Every free user makes the P2P network smarter. More users → more discovered skills → more reasons to use the platform → more users.
2. **Switching Costs:** Enterprise customers build skill governance policies, approval workflows, and private rings. Migrating means rebuilding all of that.
3. **Speed Lock-in:** API replay sequences are tuned to specific site backends. A competitor can copy the UI, but not the 10,000 verified HTTP call sequences.
4. **Community → Marketplace Pipeline:** The most popular discovered skills graduate to the verified marketplace. The marketplace is a curated, monetized view of the P2P long tail.

---

## Risk & Mitigation

| Risk | Mitigation |
|---|---|
| Free users never convert | Limit browser pool size for free tier (max 2 sessions). Make slowness felt. |
| Malicious skills on P2P | Local verification is mandatory. Hash mismatch = reject. Enterprise = whitelist only. |
| Competitor copies P2P data | Skills are content-addressed. A copy is just another peer seeding the same hash. We win on curation and API replay. |
| Enterprises don't trust P2P | Private ring is org-only. Public P2P is disabled by default in Enterprise. |
| Support burden on free tier | Community support only. Free tier has no SLA. |

---

## First 90 Days

| Week | Action |
|---|---|
| 1-2 | Ship P2P discovery stub (local-only, no network). Update skills.ts with tier fields. |
| 3-4 | Add "Upgrade to Pro for API Replay" CTA in browser execution traces. |
| 5-6 | Launch 5 verified marketplace skills (Zoho, GitHub, Salesforce, Shopify, QuickBooks). |
| 7-8 | Open beta for Enterprise private rings. Onboard 3 design partners. |
| 9-12 | Measure conversion funnel. Tune pricing. Add annual discount (2 months free). |

---

## Metrics That Matter

| Metric | Target |
|---|---|
| Free → Pro conversion rate | >5% |
| Pro → Enterprise conversion rate | >2% |
| P2P-discovered skills / total skills | >60% (shows network health) |
| Avg. skill reliability (discovered) | >0.80 |
| Avg. skill reliability (verified) | >0.95 |
| API replay speedup vs browser | >20x |
| Enterprise NRR (net revenue retention) | >120% |

---

> **Summary:** P2P is free infrastructure. Monetization is speed, trust, and governance.
