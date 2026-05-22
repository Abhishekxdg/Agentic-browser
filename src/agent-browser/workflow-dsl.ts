/**
 * Declarative Workflow DSL — YAML/JSON workflow definitions.
 * No code required for common workflows. Compiles to WorkflowGraph.
 *
 * Supported step types:
 *   navigate, fill, click, press, wait, screenshot, evaluate_js,
 *   verify, branch, skill, loop
 *
 * Parameter interpolation: {{param_name}} in any string field.
 *
 * Example YAML:
 *   name: github_create_issue
 *   site: github.com
 *   parameters:
 *     - name: repo
 *       type: string
 *       required: true
 *   steps:
 *     - id: go
 *       type: navigate
 *       url: "https://github.com/{{repo}}/issues/new"
 *     - id: fill_title
 *       type: fill
 *       form: new_issue
 *       field: title
 *       value: "{{title}}"
 *       depends_on: [go]
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from "./workflow-graph.ts";
import { saveWorkflow } from "./workflow-graph.ts";
import type { SemanticAction } from "./action-resolver.ts";

const DSL_DIR = join(homedir(), ".sound-browser", "dsl-workflows");

// ── DSL types ──────────────────────────────────────────────────────────────

export interface DSLParameter {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string;
  description?: string;
}

export type DSLStepType =
  | "navigate"
  | "fill"
  | "click"
  | "press"
  | "wait"
  | "screenshot"
  | "evaluate_js"
  | "verify"
  | "branch"
  | "skill"
  | "loop";

export interface DSLStep {
  id: string;
  type: DSLStepType;
  description?: string;
  depends_on?: string[];
  retry?: number;
  optional?: boolean;
  checkpoint?: boolean;

  // navigate
  url?: string;

  // fill
  form?: string;
  field?: string;
  value?: string;
  selector?: string;

  // click
  target?: string;
  text?: string;

  // press
  key?: string;

  // wait
  condition?: string;   // "network.idle" | "time" | JS expression
  ms?: number;

  // evaluate_js
  expression?: string;

  // verify — assert page state
  assert?: string;      // JS expression returning boolean

  // branch
  if_condition?: string;  // JS expression returning boolean
  if_true?: string;       // step id to jump to
  if_false?: string;      // step id to jump to

  // skill
  skill?: string;
  params?: Record<string, string>;

  // loop
  over?: string;          // comma-separated list or {{param}}
  item_var?: string;
  steps?: DSLStep[];      // nested steps
}

export interface DSLWorkflow {
  name: string;
  site: string;
  version?: number;
  description?: string;
  parameters?: DSLParameter[];
  steps: DSLStep[];
}

// ── Parser ─────────────────────────────────────────────────────────────────

export function parseDSL(input: string): DSLWorkflow {
  // Try JSON first, then YAML (simple key:value parser, no external dep)
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as DSLWorkflow;
  }
  return parseYAML(trimmed);
}

/**
 * Minimal YAML parser for workflow DSL.
 * Handles: scalars, lists (- item), objects (key: value), nested blocks.
 * Good enough for workflow definitions; not a full YAML spec.
 */
function parseYAML(yaml: string): DSLWorkflow {
  const lines = yaml.split("\n");
  return parseBlock(lines, 0, lines.length, 0) as unknown as DSLWorkflow;
}

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function parseBlock(lines: string[], start: number, end: number, baseIndent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < end) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const indent = getIndent(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }

    // List item
    if (trimmed.startsWith("- ")) {
      // Handled by caller via parseList
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest) {
      // Inline value
      result[key] = parseScalar(rest);
      i++;
    } else {
      // Look ahead for nested content
      i++;
      if (i >= end) { result[key] = null; continue; }

      const nextLine = lines[i]!;
      const nextTrimmed = nextLine.trim();
      if (!nextTrimmed || nextTrimmed.startsWith("#")) {
        result[key] = null;
        continue;
      }

      const nextIndent = getIndent(nextLine);
      if (nextIndent <= indent) {
        result[key] = null;
        continue;
      }

      if (nextTrimmed.startsWith("- ")) {
        // It's a list
        const [listEnd, list] = parseList(lines, i, end, nextIndent);
        result[key] = list;
        i = listEnd;
      } else {
        // It's a nested object
        const objEnd = findBlockEnd(lines, i, end, nextIndent);
        result[key] = parseBlock(lines, i, objEnd, nextIndent);
        i = objEnd;
      }
    }
  }

  return result;
}

function parseList(lines: string[], start: number, end: number, indent: number): [number, unknown[]] {
  const list: unknown[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const lineIndent = getIndent(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) { i++; continue; }

    if (!trimmed.startsWith("- ")) break;

    const itemContent = trimmed.slice(2).trim();
    i++;

    if (itemContent.includes(":")) {
      // Object item — parse inline + nested
      const obj: Record<string, unknown> = {};
      const colonIdx = itemContent.indexOf(":");
      const k = itemContent.slice(0, colonIdx).trim();
      const v = itemContent.slice(colonIdx + 1).trim();
      if (v) obj[k] = parseScalar(v);
      else obj[k] = null;

      // Continue parsing at this indent level + 2 for nested keys
      const nestedIndent = indent + 2;
      while (i < end) {
        const nested = lines[i]!;
        const nt = nested.trim();
        if (!nt || nt.startsWith("#")) { i++; continue; }
        const ni = getIndent(nested);
        if (ni < nestedIndent) break;
        if (ni > nestedIndent) { i++; continue; }
        if (nt.startsWith("- ")) break; // new list item at same parent indent

        const nc = nt.indexOf(":");
        if (nc === -1) { i++; continue; }
        const nk = nt.slice(0, nc).trim();
        const nr = nt.slice(nc + 1).trim();

        if (nr) {
          obj[nk] = parseScalar(nr);
          i++;
        } else {
          i++;
          if (i < end) {
            const peek = lines[i]!;
            const peekT = peek.trim();
            const peekI = getIndent(peek);
            if (peekT.startsWith("- ") && peekI > nestedIndent) {
              const [lEnd, lArr] = parseList(lines, i, end, peekI);
              obj[nk] = lArr;
              i = lEnd;
            } else if (peekI > nestedIndent) {
              const bEnd = findBlockEnd(lines, i, end, peekI);
              obj[nk] = parseBlock(lines, i, bEnd, peekI);
              i = bEnd;
            } else {
              obj[nk] = null;
            }
          } else {
            obj[nk] = null;
          }
        }
      }
      list.push(obj);
    } else {
      list.push(parseScalar(itemContent));
    }
  }

  return [i, list];
}

function findBlockEnd(lines: string[], start: number, end: number, indent: number): number {
  let i = start;
  while (i < end) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }
    const li = getIndent(line);
    if (li < indent) return i;
    i++;
  }
  return end;
}

function parseScalar(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  const n = Number(v);
  if (!isNaN(n) && v.length > 0) return n;
  // Inline flow sequence: [item1, item2]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  // Strip quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function validateDSL(wf: DSLWorkflow): string[] {
  const errors: string[] = [];
  if (!wf.name) errors.push("name is required");
  if (!wf.site) errors.push("site is required");
  if (!wf.steps || wf.steps.length === 0) errors.push("steps cannot be empty");

  const stepIds = new Set<string>();
  for (const step of wf.steps ?? []) {
    if (!step.id) errors.push(`step missing id: ${JSON.stringify(step)}`);
    if (stepIds.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (!step.type) errors.push(`step "${step.id}" missing type`);
  }

  for (const step of wf.steps ?? []) {
    for (const dep of step.depends_on ?? []) {
      if (!stepIds.has(dep)) errors.push(`step "${step.id}" depends_on unknown step "${dep}"`);
    }
    if (step.type === "branch") {
      if (!step.if_condition) errors.push(`branch step "${step.id}" missing if_condition`);
      if (!step.if_true && !step.if_false) errors.push(`branch step "${step.id}" needs if_true or if_false`);
    }
    if (step.type === "skill" && !step.skill) errors.push(`skill step "${step.id}" missing skill name`);
    if (step.type === "navigate" && !step.url) errors.push(`navigate step "${step.id}" missing url`);
    if (step.type === "loop" && !step.over) errors.push(`loop step "${step.id}" missing over`);
  }

  return errors;
}

// ── Compiler: DSL → WorkflowGraph ─────────────────────────────────────────

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? `{{${key}}}`);
}

function compileStep(step: DSLStep, params: Record<string, string>): { node: WorkflowNode; actions: SemanticAction[] } {
  const itp = (s: string) => interpolate(s, params);
  const actions: SemanticAction[] = [];

  switch (step.type) {
    case "navigate":
      actions.push({ type: "navigate", url: itp(step.url ?? "") });
      break;
    case "fill":
      if (step.selector) {
        actions.push({ type: "fill_selector", selector: itp(step.selector), value: itp(step.value ?? "") });
      } else {
        actions.push({ type: "fill", form: itp(step.form ?? "form"), field: itp(step.field ?? ""), value: itp(step.value ?? "") });
      }
      break;
    case "click":
      if (step.selector) {
        actions.push({ type: "click_selector", selector: itp(step.selector) });
      } else if (step.text) {
        actions.push({ type: "click_text", text: itp(step.text) });
      } else {
        actions.push({ type: "click", target: itp(step.target ?? "") });
      }
      break;
    case "press":
      actions.push({ type: "press", key: itp(step.key ?? "Enter") });
      break;
    case "wait":
      actions.push({ type: "wait", condition: itp(step.condition ?? "time") as "page.load" | "network.idle" | "time", ms: step.ms ?? 1000 });
      break;
    case "screenshot":
      actions.push({ type: "screenshot" });
      break;
    case "evaluate_js":
      actions.push({ type: "evaluate", expression: itp(step.expression ?? "") });
      break;
    case "verify":
      // verify steps are no-op actions; the workflow executor handles assertion
      actions.push({ type: "wait", condition: "time", ms: 100 });
      break;
    case "branch":
      // branch encoded as evaluate_js returning marker value
      actions.push({ type: "evaluate", expression: `(${itp(step.if_condition ?? "false")}) ? "__branch_true__" : "__branch_false__"` });
      break;
    case "skill":
      // skill steps also encoded for the executor to interpret
      actions.push({ type: "evaluate", expression: `JSON.stringify({_skill: "${itp(step.skill ?? "")}", _params: ${JSON.stringify(step.params ?? {})}})` });
      break;
    case "loop":
      // loop body compiled recursively; encoded as evaluate for now
      actions.push({ type: "wait", condition: "time", ms: 100 });
      break;
  }

  const node: WorkflowNode = {
    id: step.id,
    label: step.description ?? `${step.type}: ${step.id}`,
    description: step.description ?? "",
    expected_outcome: step.type === "verify" ? (step.assert ?? "") : "",
    actions,
    depends_on: step.depends_on ?? [],
    max_retries: step.retry ?? 1,
    checkpoint: step.checkpoint ?? false,
    optional: step.optional ?? false,
  };

  return { node, actions };
}

/**
 * Compile a DSL workflow (with optional parameter values) to a WorkflowGraph.
 * The returned graph can be passed directly to executeWorkflow().
 */
export function compileDSL(wf: DSLWorkflow, params: Record<string, string> = {}): WorkflowGraph {
  // Apply defaults for missing optional params
  for (const p of wf.parameters ?? []) {
    if (!(p.name in params) && p.default !== undefined) {
      params[p.name] = p.default;
    }
    if (p.required && !(p.name in params)) {
      throw new Error(`Workflow "${wf.name}" requires parameter: ${p.name}`);
    }
  }

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  for (const step of wf.steps) {
    const { node } = compileStep(step, params);
    nodes.push(node);

    // edges from depends_on
    for (const dep of step.depends_on ?? []) {
      edges.push({ from: dep, to: step.id, condition: "on_success" });
    }

    // branch edges
    if (step.type === "branch") {
      if (step.if_true) edges.push({ from: step.id, to: step.if_true, condition: "always" });
      if (step.if_false) edges.push({ from: step.id, to: step.if_false, condition: "always" });
    }
  }

  // Steps with no depends_on and no incoming edges — add implicit linear chain
  // Only if the user didn't define any depends_on at all (detect by checking if any step has depends_on)
  const anyDepsSpecified = wf.steps.some((s) => s.depends_on && s.depends_on.length > 0);
  if (!anyDepsSpecified && wf.steps.length > 1) {
    for (let i = 1; i < wf.steps.length; i++) {
      const previousStep = wf.steps[i - 1]!;
      const currentStep = wf.steps[i]!;
      const currentNode = nodes[i]!;
      edges.push({ from: previousStep.id, to: currentStep.id, condition: "on_success" });
      currentNode.depends_on = [previousStep.id];
    }
  }

  const graph: WorkflowGraph = {
    id: `dsl_${wf.name.replace(/\W+/g, "_").toLowerCase()}_${Date.now()}`,
    name: wf.name,
    site: wf.site,
    nodes,
    edges,
    created_at: new Date().toISOString(),
    version: wf.version ?? 1,
  };

  return graph;
}

// ── DSL file storage ───────────────────────────────────────────────────────

function ensureDir() {
  if (!existsSync(DSL_DIR)) mkdirSync(DSL_DIR, { recursive: true });
}

function dslPath(name: string) {
  return join(DSL_DIR, `${name.replace(/\W+/g, "_").toLowerCase()}.yaml`);
}

export function saveDSLWorkflow(wf: DSLWorkflow, content: string): void {
  ensureDir();
  writeFileSync(dslPath(wf.name), content, "utf8");
}

export function loadDSLWorkflow(name: string): string | null {
  const p = dslPath(name);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

export function listDSLWorkflows(): Array<{ name: string; site: string; path: string }> {
  ensureDir();
  return readdirSync(DSL_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".json"))
    .map((f) => {
      try {
        const content = readFileSync(join(DSL_DIR, f), "utf8");
        const wf = parseDSL(content);
        return { name: wf.name, site: wf.site ?? "*", path: join(DSL_DIR, f) };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{ name: string; site: string; path: string }>;
}

/**
 * Compile and immediately save to the workflow graph store (so executeWorkflow can run it).
 * Returns the graph ID.
 */
export function compileAndSaveDSL(content: string, params: Record<string, string> = {}): string {
  const wf = parseDSL(content);
  const errors = validateDSL(wf);
  if (errors.length > 0) throw new Error(`DSL validation failed:\n${errors.join("\n")}`);
  const graph = compileDSL(wf, params);
  saveWorkflow(graph);
  saveDSLWorkflow(wf, content);
  return graph.id;
}
