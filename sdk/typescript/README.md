# Sound Browser TypeScript SDK

Semantic browser automation for AI agents.

```bash
npm install sound-browser
```

```ts
import { SoundBrowser } from "sound-browser";

const browser = new SoundBrowser();

await browser.session(async (sessionId) => {
  await browser.navigate(sessionId, "https://example.com");
  const page = await browser.getPage(sessionId);
  console.log(page.page.title);
});
```

## Agent in Under 20 Lines

```ts
import { SoundBrowser } from "sound-browser";

const browser = new SoundBrowser({
  apiKey: process.env.SOUND_BROWSER_API_KEY,
});

const result = await browser.session(async (sessionId) => {
  await browser.navigate(sessionId, "https://app.example.com");
  return browser.run(sessionId, "Export all invoices from Q1 as CSV");
});

console.log(result.final_answer ?? result.error);
```

## Eval and Replay

```ts
const evalRun = await browser.runEval([
  {
    name: "example smoke",
    actions: [{ type: "navigate", url: "https://example.com" }],
    checks: [{ name: "title", expression: "document.title.includes('Example')" }],
  },
]);

console.log(evalRun.summary);
```
