import { describe, it, expect } from "bun:test";
import {
  checkPermission, checkRateLimit, createPolicyFromPreset, actionTypeToPermission,
  type AgentPolicy,
} from "./rbac.ts";

const basePolicy: AgentPolicy = {
  agent_id: "agent-1",
  org_id: "org-test",
  allow: ["navigate", "read_page", "click"],
  deny: [],
  created_at: new Date().toISOString(),
};

describe("checkPermission", () => {
  it("allows explicitly granted permission", () => {
    const r = checkPermission(basePolicy, "navigate");
    expect(r.allowed).toBe(true);
  });

  it("denies permission not in allow list", () => {
    const r = checkPermission(basePolicy, "fill");
    expect(r.allowed).toBe(false);
  });

  it("deny overrides wildcard allow", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["*"], deny: ["evaluate_js"] };
    expect(checkPermission(policy, "evaluate_js").allowed).toBe(false);
    expect(checkPermission(policy, "navigate").allowed).toBe(true);
  });

  it("wildcard allow grants everything not denied", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["*"], deny: [] };
    expect(checkPermission(policy, "use_vault").allowed).toBe(true);
    expect(checkPermission(policy, "run_agent").allowed).toBe(true);
  });

  it("blocks denied site", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["*"], deny: [], denied_sites: ["evil.com"] };
    expect(checkPermission(policy, "navigate", "https://evil.com/path").allowed).toBe(false);
  });

  it("allows explicitly listed site", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["navigate"], deny: [], allowed_sites: ["github.com"] };
    expect(checkPermission(policy, "navigate", "https://github.com/torvalds").allowed).toBe(true);
  });

  it("blocks non-listed site when allowed_sites set", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["navigate"], deny: [], allowed_sites: ["github.com"] };
    expect(checkPermission(policy, "navigate", "https://evil.com").allowed).toBe(false);
  });

  it("wildcard site pattern *.google.com", () => {
    const policy: AgentPolicy = { ...basePolicy, allow: ["navigate"], deny: [], allowed_sites: ["*.google.com"] };
    expect(checkPermission(policy, "navigate", "https://mail.google.com").allowed).toBe(true);
    expect(checkPermission(policy, "navigate", "https://google.com").allowed).toBe(false);
  });
});

describe("createPolicyFromPreset", () => {
  it("read-only preset denies click", () => {
    const p = createPolicyFromPreset("a1", "org1", "read-only");
    expect(checkPermission(p, "click").allowed).toBe(false);
    expect(checkPermission(p, "navigate").allowed).toBe(true);
    expect(checkPermission(p, "read_page").allowed).toBe(true);
  });

  it("full-access preset allows everything", () => {
    const p = createPolicyFromPreset("a2", "org1", "full-access");
    expect(checkPermission(p, "evaluate_js").allowed).toBe(true);
    expect(checkPermission(p, "use_vault").allowed).toBe(true);
  });

  it("form-fill preset allows fill but not evaluate_js", () => {
    const p = createPolicyFromPreset("a3", "org1", "form-fill");
    expect(checkPermission(p, "fill").allowed).toBe(true);
    expect(checkPermission(p, "evaluate_js").allowed).toBe(false);
  });

  it("throws on unknown preset", () => {
    expect(() => createPolicyFromPreset("a", "org", "nonexistent" as any)).toThrow();
  });
});

describe("actionTypeToPermission", () => {
  it("maps navigate to navigate", () => expect(actionTypeToPermission("navigate")).toBe("navigate"));
  it("maps click to click", () => expect(actionTypeToPermission("click")).toBe("click"));
  it("maps fill to fill", () => expect(actionTypeToPermission("fill")).toBe("fill"));
  it("maps fill_selector to fill", () => expect(actionTypeToPermission("fill_selector")).toBe("fill"));
  it("maps evaluate to evaluate_js", () => expect(actionTypeToPermission("evaluate")).toBe("evaluate_js"));
  it("maps press to click (interaction)", () => expect(actionTypeToPermission("press")).toBe("click"));
  it("maps unknown to click (safe default)", () => expect(actionTypeToPermission("unknown_type")).toBe("click"));
});

describe("checkRateLimit", () => {
  it("passes when no rate limit set", () => {
    const p: AgentPolicy = { ...basePolicy, agent_id: "rl-none" };
    expect(checkRateLimit(p).allowed).toBe(true);
  });

  it("allows requests under the limit", () => {
    const p: AgentPolicy = { ...basePolicy, agent_id: "rl-under", rate_limit: { requests_per_minute: 10 } };
    for (let i = 0; i < 5; i++) checkRateLimit(p);
    expect(checkRateLimit(p).allowed).toBe(true);
  });

  it("blocks requests over the limit", () => {
    const p: AgentPolicy = { ...basePolicy, agent_id: "rl-over", rate_limit: { requests_per_minute: 3 } };
    for (let i = 0; i < 4; i++) checkRateLimit(p);
    expect(checkRateLimit(p).allowed).toBe(false);
  });
});
