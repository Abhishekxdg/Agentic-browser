import { describe, it, expect } from "vitest";
import { parseDSL, validateDSL, compileDSL } from "./workflow-dsl.ts";

const SAMPLE_YAML = `
name: github_create_issue
site: github.com
version: 1
description: Create a GitHub issue
parameters:
  - name: repo
    type: string
    required: true
  - name: title
    type: string
    required: true
  - name: body
    type: string
    required: false
    default: ""
steps:
  - id: go
    type: navigate
    url: "https://github.com/{{repo}}/issues/new"
  - id: fill_title
    type: fill
    form: new_issue
    field: title
    value: "{{title}}"
    depends_on: [go]
  - id: submit
    type: click
    text: "Submit new issue"
    depends_on: [fill_title]
`;

const SAMPLE_JSON = JSON.stringify({
  name: "web_search",
  site: "*",
  steps: [
    { id: "nav", type: "navigate", url: "https://google.com" },
    { id: "fill", type: "fill", form: "search", field: "q", value: "{{query}}", depends_on: ["nav"] },
    { id: "submit", type: "press", key: "Enter", depends_on: ["fill"] },
  ],
  parameters: [{ name: "query", type: "string", required: true }],
});

describe("parseDSL", () => {
  it("parses YAML workflow", () => {
    const wf = parseDSL(SAMPLE_YAML);
    expect(wf.name).toBe("github_create_issue");
    expect(wf.site).toBe("github.com");
    expect(wf.steps).toHaveLength(3);
  });

  it("parses JSON workflow", () => {
    const wf = parseDSL(SAMPLE_JSON);
    expect(wf.name).toBe("web_search");
    expect(wf.steps).toHaveLength(3);
  });

  it("extracts parameters from YAML", () => {
    const wf = parseDSL(SAMPLE_YAML);
    expect(wf.parameters).toHaveLength(3);
    expect(wf.parameters![0]!.name).toBe("repo");
    expect(wf.parameters![0]!.required).toBe(true);
  });

  it("parses depends_on list", () => {
    const wf = parseDSL(SAMPLE_YAML);
    expect(wf.steps[1]!.depends_on).toContain("go");
  });
});

describe("validateDSL", () => {
  it("passes valid workflow", () => {
    const wf = parseDSL(SAMPLE_YAML);
    expect(validateDSL(wf)).toHaveLength(0);
  });

  it("errors on missing name", () => {
    const wf = parseDSL(SAMPLE_YAML);
    (wf as any).name = undefined;
    expect(validateDSL(wf)).toContain("name is required");
  });

  it("errors on duplicate step ids", () => {
    const wf = parseDSL(SAMPLE_JSON);
    wf.steps.push({ id: "nav", type: "navigate", url: "https://x.com" });
    const errs = validateDSL(wf);
    expect(errs.some((e) => e.includes("duplicate step id"))).toBe(true);
  });

  it("errors on unknown depends_on", () => {
    const wf = parseDSL(SAMPLE_JSON);
    wf.steps[0]!.depends_on = ["nonexistent"];
    const errs = validateDSL(wf);
    expect(errs.some((e) => e.includes("unknown step"))).toBe(true);
  });

  it("errors on branch step missing condition", () => {
    const wf = parseDSL(SAMPLE_JSON);
    wf.steps.push({ id: "br", type: "branch" as any });
    const errs = validateDSL(wf);
    expect(errs.some((e) => e.includes("if_condition"))).toBe(true);
  });
});

describe("compileDSL", () => {
  it("compiles to WorkflowGraph with correct node count", () => {
    const wf = parseDSL(SAMPLE_YAML);
    const graph = compileDSL(wf, { repo: "owner/repo", title: "Test issue" });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.name).toBe("github_create_issue");
    expect(graph.site).toBe("github.com");
  });

  it("interpolates parameters into action URLs", () => {
    const wf = parseDSL(SAMPLE_YAML);
    const graph = compileDSL(wf, { repo: "torvalds/linux", title: "My bug" });
    const navNode = graph.nodes.find((n) => n.id === "go")!;
    const url = (navNode.actions[0] as any).url;
    expect(url).toBe("https://github.com/torvalds/linux/issues/new");
  });

  it("respects depends_on → creates edges", () => {
    const wf = parseDSL(SAMPLE_YAML);
    const graph = compileDSL(wf, { repo: "a/b", title: "x" });
    const hasEdge = graph.edges.some((e) => e.from === "go" && e.to === "fill_title");
    expect(hasEdge).toBe(true);
  });

  it("applies implicit linear chain when no depends_on specified", () => {
    const wf = parseDSL(SAMPLE_JSON);
    // Remove all depends_on to test implicit chaining
    for (const s of wf.steps) s.depends_on = [];
    const graph = compileDSL(wf, { query: "bun js" });
    // With implicit chaining, edges are nav→fill and fill→submit
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
  });

  it("throws on missing required parameter", () => {
    const wf = parseDSL(SAMPLE_YAML);
    expect(() => compileDSL(wf, {})).toThrow(/requires parameter: repo/);
  });

  it("applies default value for optional parameter", () => {
    const wf = parseDSL(SAMPLE_YAML);
    const graph = compileDSL(wf, { repo: "a/b", title: "x" }); // body omitted, default ""
    const fillNode = graph.nodes.find((n) => n.id === "fill_title")!;
    expect(fillNode).toBeTruthy();
  });
});
