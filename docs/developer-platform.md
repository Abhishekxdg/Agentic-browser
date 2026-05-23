# Developer Platform

Phase 5 adds repeatable evals and replay for agent workflows.

## Eval API

`POST /eval/run`

```json
{
  "cases": [
    {
      "name": "example smoke",
      "actions": [
        { "type": "navigate", "url": "https://example.com" },
        { "type": "wait", "condition": "network.idle", "ms": 1000 }
      ],
      "checks": [
        { "name": "title", "expression": "document.title.includes('Example')" }
      ]
    }
  ]
}
```

Returns reliability score, action success rate, latency, hallucination rate, and per-check results.

## Replay API

`POST /replay/actions`

```json
{
  "actions": [
    { "type": "navigate", "url": "https://example.com" },
    { "type": "click", "target": "More information" }
  ],
  "stop_on_failure": true
}
```

`POST /replay/trace`

```json
{
  "trace_session_id": "sess_abc123",
  "stop_on_failure": true
}
```

Trace replay reads actions saved by `/session/:id/trace/start` and `/session/:id/trace/stop`.

## TypeScript SDK

```ts
import { SoundBrowser } from "sound-browser";

const browser = new SoundBrowser();

const evalRun = await browser.runEval([
  {
    name: "example smoke",
    actions: [{ type: "navigate", url: "https://example.com" }],
    checks: [{ name: "title", expression: "document.title.includes('Example')" }],
  },
]);

console.log(evalRun.summary.reliability_score);
```
