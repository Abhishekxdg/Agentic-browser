/**
 * Skill System — reusable semantic workflows for common sites.
 * Skills combine: workflow graph + auth patterns + common intents.
 * Agents invoke skills by name: agent.skill("gmail.send_email", {...})
 *
 * Built-in skills ship with the project.
 * Custom skills stored at ~/.sound-browser/skills/<name>.json
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import type { SemanticAction } from "./action-resolver.ts";

const SKILLS_DIR = join(homedir(), ".sound-browser", "skills");

export interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  example?: string;
}

export interface SkillStep {
  description: string;
  actions: SemanticAction[];
  verify?: string;     // JS expression for verification
  retry?: number;
}

export interface Skill {
  name: string;           // e.g. "gmail.send_email"
  site: string;           // e.g. "mail.google.com"
  description: string;
  parameters: SkillParameter[];
  steps: SkillStep[];
  auth_required: boolean;
  created_at: string;
  source: "builtin" | "custom" | "community";
  reliability?: number;   // 0-1, based on usage stats
  use_count?: number;
}

// ── Built-in skills ────────────────────────────────────────────────────────

const BUILTIN_SKILLS: Skill[] = [
  {
    name: "web.navigate_and_extract",
    site: "*",
    description: "Navigate to a URL and extract the semantic page model",
    parameters: [{ name: "url", type: "string", required: true, description: "URL to navigate to", example: "https://example.com" }],
    steps: [
      { description: "Navigate to URL", actions: [{ type: "navigate", url: "{{url}}" }] },
      { description: "Wait for page load", actions: [{ type: "wait", condition: "network.idle", ms: 3000 }] },
    ],
    auth_required: false,
    created_at: "2026-01-01T00:00:00Z",
    source: "builtin",
    reliability: 0.99,
  },
  {
    name: "web.fill_and_submit",
    site: "*",
    description: "Fill a form and submit it",
    parameters: [
      { name: "form_id", type: "string", required: true, description: "Form ID or purpose", example: "login" },
      { name: "fields", type: "string", required: true, description: "JSON object of {fieldName: value}", example: '{"email":"x@y.com"}' },
      { name: "submit_label", type: "string", required: false, description: "Submit button label", example: "Sign in" },
    ],
    steps: [
      { description: "Fill form fields", actions: [] }, // populated at runtime
      { description: "Submit form", actions: [{ type: "press", key: "Enter" }] },
      { description: "Wait for response", actions: [{ type: "wait", condition: "network.idle", ms: 3000 }] },
    ],
    auth_required: false,
    created_at: "2026-01-01T00:00:00Z",
    source: "builtin",
    reliability: 0.90,
  },
  {
    name: "github.create_issue",
    site: "github.com",
    description: "Create a new issue on a GitHub repository",
    parameters: [
      { name: "repo", type: "string", required: true, description: "owner/repo", example: "torvalds/linux" },
      { name: "title", type: "string", required: true, description: "Issue title" },
      { name: "body", type: "string", required: false, description: "Issue body" },
    ],
    steps: [
      { description: "Navigate to new issue page", actions: [{ type: "navigate", url: "https://github.com/{{repo}}/issues/new" }] },
      { description: "Fill title", actions: [{ type: "fill_selector", selector: "#issue_title", value: "{{title}}" }] },
      { description: "Fill body", actions: [{ type: "fill_selector", selector: "#issue_body", value: "{{body}}" }] },
      { description: "Submit", actions: [{ type: "click_selector", selector: 'button[type="submit"]' }] },
      { description: "Wait", actions: [{ type: "wait", condition: "network.idle", ms: 3000 }] },
    ],
    auth_required: true,
    created_at: "2026-01-01T00:00:00Z",
    source: "builtin",
    reliability: 0.92,
  },
  {
    name: "github.star_repo",
    site: "github.com",
    description: "Star a GitHub repository",
    parameters: [{ name: "repo", type: "string", required: true, description: "owner/repo", example: "torvalds/linux" }],
    steps: [
      { description: "Navigate to repo", actions: [{ type: "navigate", url: "https://github.com/{{repo}}" }] },
      { description: "Click star button", actions: [{ type: "click_text", text: "Star" }] },
      { description: "Wait", actions: [{ type: "wait", condition: "time", ms: 1000 }] },
    ],
    auth_required: true,
    created_at: "2026-01-01T00:00:00Z",
    source: "builtin",
    reliability: 0.95,
  },
  {
    name: "web.search",
    site: "*",
    description: "Perform a search on a page",
    parameters: [
      { name: "query", type: "string", required: true, description: "Search query" },
      { name: "url", type: "string", required: false, description: "URL to navigate to first" },
    ],
    steps: [
      { description: "Navigate if URL given", actions: [] }, // conditional at runtime
      { description: "Fill search", actions: [{ type: "fill", form: "search", field: "q", value: "{{query}}" }] },
      { description: "Submit", actions: [{ type: "press", key: "Enter" }] },
      { description: "Wait", actions: [{ type: "wait", condition: "network.idle", ms: 3000 }] },
    ],
    auth_required: false,
    created_at: "2026-01-01T00:00:00Z",
    source: "builtin",
    reliability: 0.93,
  },
];

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir() { if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true }); }
function skillPath(name: string) { return join(SKILLS_DIR, `${name.replace(/\./g, "_")}.json`); }

export function saveSkill(skill: Skill): void {
  ensureDir();
  writeFileSync(skillPath(skill.name), JSON.stringify(skill, null, 2), "utf8");
}

export function loadSkill(name: string): Skill | null {
  // Check custom first, then builtin
  const custom = skillPath(name);
  if (existsSync(custom)) return JSON.parse(readFileSync(custom, "utf8"));
  return BUILTIN_SKILLS.find((s) => s.name === name) ?? null;
}

export function listSkills(site?: string): Array<{ name: string; description: string; site: string; source: string; reliability?: number }> {
  ensureDir();
  const custom = readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(readFileSync(join(SKILLS_DIR, f), "utf8")) as Skill; } catch { return null; } })
    .filter(Boolean) as Skill[];

  const all = [...BUILTIN_SKILLS, ...custom];
  const filtered = site ? all.filter((s) => s.site === "*" || s.site.includes(site)) : all;
  return filtered.map((s) => ({ name: s.name, description: s.description, site: s.site, source: s.source, reliability: s.reliability }));
}

// ── Parameter interpolation ────────────────────────────────────────────────

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? `{{${key}}}`);
}

function interpolateAction(action: SemanticAction, params: Record<string, string>): SemanticAction {
  return JSON.parse(interpolate(JSON.stringify(action), params));
}

// ── Resolve skill steps with params ────────────────────────────────────────

export function resolveSkill(skill: Skill, params: Record<string, string>): SkillStep[] {
  // Validate required params
  for (const p of skill.parameters) {
    if (p.required && !params[p.name]) {
      throw new Error(`Skill "${skill.name}" requires parameter: ${p.name}`);
    }
  }

  return skill.steps
    .map((step): SkillStep | null => {
      // Skip navigation step if no URL param given for web.search
      if (step.description.includes("Navigate if URL given") && !params.url) return null;

      const actions = step.actions
        .map((a) => interpolateAction(a, params))
        .filter(Boolean) as SemanticAction[];

      // For web.fill_and_submit — dynamically build fill actions from fields param
      if (step.description.includes("Fill form fields") && params.fields) {
        try {
          const fields = JSON.parse(params.fields) as Record<string, string>;
          const form = params.form_id ?? "form";
          return {
            ...step,
            actions: Object.entries(fields).map(([field, value]) => ({
              type: "fill" as const, form, field, value,
            })),
          };
        } catch { return step; }
      }

      return { ...step, actions };
    })
    .filter(Boolean) as SkillStep[];
}

export function incrementUseCount(name: string): void {
  const skill = loadSkill(name);
  if (skill && skill.source !== "builtin") {
    skill.use_count = (skill.use_count ?? 0) + 1;
    saveSkill(skill);
  }
}
