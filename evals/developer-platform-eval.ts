import { runEvalCases } from "../src/agent-browser/eval-framework.ts";

process.env.EXTENSION_DISABLED = "true";

const result = await runEvalCases([
  {
    name: "example.com navigation smoke",
    actions: [
      { type: "navigate", url: "https://example.com" },
      { type: "wait", condition: "network.idle", ms: 1000 },
    ],
    checks: [
      { name: "title contains Example", expression: "document.title.includes('Example')" },
      { name: "body has text", expression: "document.body.innerText.includes('Example Domain')" },
    ],
  },
]);

console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
