# TODOS

## From /plan-eng-review (2026-05-22)

### TODO-1: CDP disconnect handling during recording
**What:** Detect CDP connection loss during `begin_recording()` → `end_recording()` window and surface a recoverable error to the SDK caller.
**Why:** CDP disconnects on browser crash or unexpected navigation produce empty/truncated graphs that corrupt the workflow baseline silently.
**Context:** Subscribe to `Target.targetCrashed` and WebSocket `close` events in the Session Recorder. On disconnect, call internal `onRecordingError()` that surfaces to the SDK caller with a recoverable `RecordingInterruptedError`.
**Depends on:** Session Recorder Layer implementation.

### TODO-2: Null data extractor handling in execution engine
**What:** When `output_extractors[]` JSONPath returns null, emit `ExtractorDriftError` with the JSONPath and actual response body rather than passing null to the next step.
**Why:** Null binding surfaces as a 404 on `/invoices/null/submit`, which is misread as endpoint drift. The actual cause (wrong JSONPath) is invisible.
**Context:** After each extractor application, validate non-null before injecting into next step's params. Include the failing JSONPath and raw response in the error.
**Depends on:** Execution Engine + data chaining implementation.

### TODO-4: Integration tests for src/agent-browser/
**What:** Write integration tests for the REST API: POST /session, GET /session/:id/page, POST /session/:id/navigate, POST /session/:id/action (fill/click/screenshot).
**Why:** src/agent-browser/ is the core shipped product and has zero test coverage. The executor, graph, and recorder modules have 42 tests; the REST API layer has none. No regression net when external users report bugs.
**Context:** Create src/agent-browser/server.test.ts. Launch a real browser session in test setup, drive it against a local static HTML fixture, assert page model structure and action results. Use bun test. Teardown must kill Chrome.
**Priority:** P2 — doesn't block v0.1 ship, but should land before first paying user.
**Effort:** Human ~1d / CC ~30min
**Depends on:** v0.1 ship complete.

### TODO-3: Atomic graph_version bump to prevent sequence cache race condition
**What:** Wrap graph mutations in a Postgres transaction that atomically updates graph nodes AND increments `orgs.graph_version`.
**Why:** Non-atomic graph_version updates allow a race where concurrent `agent.do()` calls read a stale cached sequence against a newly updated graph.
**Context:** `BEGIN; UPDATE graph_nodes ...; UPDATE orgs SET graph_version = graph_version + 1 WHERE id = :org_id; COMMIT;` — the transaction atomicity prevents the stale cache window.
**Depends on:** Postgres schema design + API Graph Extractor implementation.
