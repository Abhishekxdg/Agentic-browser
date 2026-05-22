/**
 * Autonomous Agent Demo
 * The semantic browser operates without human intervention:
 * 1. Observe page state (Semantic Page Model)
 * 2. Decide what to do based on structured data
 * 3. Execute action
 * 4. Repeat until goal achieved
 */

import { createSession, executeAction, refreshPageModel, closeSession } from "./session-manager.ts";
import type { SemanticPage, SemanticForm, SemanticField } from "./semantic-page.ts";
import type { SemanticAction } from "./action-resolver.ts";

interface AgentGoal {
  description: string;
  successCondition: (page: SemanticPage) => boolean;
  maxSteps: number;
}

interface AgentStep {
  step: number;
  observation: string;
  thought: string;
  action: string;
  result?: string;
}

class AutonomousAgent {
  private steps: AgentStep[] = [];
  private currentStep = 0;

  constructor(private goal: AgentGoal) {}

  async run() {
    const session = await createSession({ browser: { headless: true } });
    console.log(`🤖 Autonomous Agent: ${this.goal.description}`);
    console.log(`   Session: ${session.id}`);
    console.log();

    try {
      while (this.currentStep < this.goal.maxSteps) {
        this.currentStep++;
        const page = await refreshPageModel(session);

        // Check success
        if (this.goal.successCondition(page)) {
          console.log(`✅ Goal achieved in ${this.currentStep} steps!`);
          this.reportSummary();
          return { success: true, steps: this.steps, session };
        }

        // Observe -> Think -> Act
        const observation = this.observe(page);
        const thought = this.think(page, observation);
        const action = this.decideAction(page, thought);

        if (!action) {
          console.log("❌ No valid action determined. Stopping.");
          break;
        }

        console.log(`\n--- Step ${this.currentStep} ---`);
        console.log(`📝 Observation: ${observation}`);
        console.log(`💭 Thought: ${thought}`);
        console.log(`🎯 Action: ${action.type}${action.type === "navigate" ? ` → ${action.url}` : ""}`);

        const result = await executeAction(session, action);

        this.steps.push({
          step: this.currentStep,
          observation,
          thought,
          action: JSON.stringify(action),
          result: result.success ? "success" : `error: ${result.error}`,
        });

        console.log(`📊 Result: ${result.success ? "✅" : "❌"} ${result.error || ""}`);

        // Wait for page to settle
        await new Promise((r) => setTimeout(r, 3000));
      }

      console.log(`\n⚠️ Max steps (${this.goal.maxSteps}) reached without achieving goal.`);
      this.reportSummary();
      return { success: false, steps: this.steps, session };
    } finally {
      await closeSession(session.id);
    }
  }

  private observe(page: SemanticPage): string {
    const parts: string[] = [];
    parts.push(`Page: "${page.page.title}"`);
    parts.push(`${page.forms.length} forms, ${page.navigation.length} links, ${page.content.length} content blocks`);

    if (page.search) {
      parts.push(`Search field: "${page.search.fieldName}"`);
    }

    if (page.forms.length > 0) {
      const formNames = page.forms.map((f) => f.purpose || f.id).join(", ");
      parts.push(`Forms: ${formNames}`);
    }

    return parts.join(" | ");
  }

  private think(page: SemanticPage, observation: string): string {
    // Simple rule-based reasoning — in production this would be an LLM
    if (page.page.url.includes("httpbin.org/forms/post")) {
      const hasEmptyFields = page.forms.some((f) =>
        f.fields.some((fld) => !fld.value && fld.type !== "submit" && fld.type !== "button")
      );
      if (hasEmptyFields) {
        return "I see a form with empty fields. I should fill them with test data and submit.";
      }
      return "The form appears to be filled. I should submit it.";
    }

    if (page.page.url.includes("wikipedia.org")) {
      if (page.page.title.toLowerCase().includes("tokyo")) {
        return "I found the Tokyo page. I should extract the relevant information.";
      }
      return "I need to search for Tokyo on Wikipedia.";
    }

    if (page.search) {
      return `There's a search field "${page.search.fieldName}". I should use it to search.`;
    }

    if (page.forms.length > 0) {
      const firstForm = page.forms[0];
      if (firstForm) {
        const emptyFields = firstForm.fields.filter(
          (f) => !f.value && f.type !== "submit" && f.type !== "button"
        );
        if (emptyFields.length > 0) {
          return `Form "${firstForm.purpose}" has ${emptyFields.length} empty fields to fill.`;
        }
        return `Form "${firstForm.purpose}" is ready to submit.`;
      }
    }

    return "I need to navigate to achieve the goal.";
  }

  private decideAction(page: SemanticPage, thought: string): SemanticAction | null {
    // Autonomous form filling on httpbin
    if (page.page.url.includes("httpbin.org/forms/post")) {
      const form = page.forms.find((f) => f.fields.length > 0);
      if (!form) return null;

      const emptyField = form.fields.find(
        (f) => !f.value && f.type !== "submit" && f.type !== "button"
      );

      if (emptyField) {
        // Generate appropriate test value based on field name/type
        const value = this.generateValue(emptyField);
        if (value === undefined) return null;
        return {
          type: "fill",
          form: form.purpose || form.id,
          field: emptyField.name,
          value,
        };
      }

      // All fields filled — submit
      const submitAction = form.actions.find((a) => a.type === "submit");
      if (submitAction) {
        return { type: "click", target: "submit", context: form.purpose || form.id };
      }
    }

    // Wikipedia search
    if (page.page.url.includes("wikipedia.org")) {
      if (!page.page.title.toLowerCase().includes("tokyo")) {
        if (page.search?.fieldName) {
          return { type: "fill", form: "search", field: page.search.fieldName, value: "Tokyo" };
        }
      }
      return { type: "extract", what: "page.content" };
    }

    // Generic search
    if (page.search && page.search.fieldName && thought.includes("search")) {
      // Extract search term from goal
      const match = this.goal.description.match(/"([^"]+)"/);
      const term = match?.[1] ?? "test";
      return { type: "fill", form: "search", field: page.search.fieldName, value: term };
    }

    // Navigate to target URL if we haven't started
    if (this.currentStep === 1) {
      if (this.goal.description.includes("httpbin")) {
        return { type: "navigate", url: "https://httpbin.org/forms/post" };
      }
      if (this.goal.description.includes("Wikipedia")) {
        return { type: "navigate", url: "https://en.wikipedia.org/wiki/Main_Page" };
      }
    }

    return null;
  }

  private generateValue(field: SemanticField): string {
    const name = field.name.toLowerCase();
    const type = field.type;

    if (type === "email" || name.includes("email")) return "test@example.com";
    if (type === "tel" || name.includes("tel")) return "555-123-4567";
    if (type === "password" || name.includes("pass")) return "SecureP@ss123";
    if (name.includes("name")) {
      if (name.includes("first")) return "John";
      if (name.includes("last")) return "Doe";
      if (name.includes("cust")) return "Test Customer";
      return "Test User";
    }
    if (name.includes("comment")) return "This is an autonomous agent test submission.";
    if (name.includes("size")) return field.options?.[0] || "medium";
    if (type === "checkbox") return "true";
    if (type === "time") return "14:30";

    return "test-value-42";
  }

  private reportSummary() {
    console.log(`\n📋 Agent Report — ${this.steps.length} steps executed:`);
    for (const s of this.steps) {
      console.log(`  ${s.step}. ${s.action} → ${s.result}`);
    }
  }
}

// ── Demo 1: Autonomous Form Filling ──────────────────────────────────
export async function demoAutonomousFormFill() {
  const agent = new AutonomousAgent({
    description: "Navigate to httpbin form and autonomously fill and submit it",
    successCondition: (page) =>
      page.page.url.includes("/post") || page.content.some((c) => c.text.includes("submitted")),
    maxSteps: 15,
  });
  return agent.run();
}

// ── Demo 2: Autonomous Wikipedia Search ────────────────────────────────
export async function demoAutonomousWikiSearch() {
  const agent = new AutonomousAgent({
    description: 'Navigate to Wikipedia and find information about "Tokyo"',
    successCondition: (page) =>
      page.page.url.toLowerCase().includes("tokyo") &&
      page.content.some((c) => c.text.includes("Japan")),
    maxSteps: 10,
  });
  return agent.run();
}

// ── Run demos if executed directly ───────────────────────────────────
if (import.meta.main) {
  console.log("=".repeat(60));
  console.log("  Autonomous Agent Demo — Semantic Browser");
  console.log("  The browser thinks, decides, and acts on its own.");
  console.log("=".repeat(60));
  console.log();

  await demoAutonomousFormFill();

  console.log("\n" + "=".repeat(60));
  console.log();

  await demoAutonomousWikiSearch();
}
