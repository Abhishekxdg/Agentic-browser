import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyHttpError, classifyExtractorNull } from "./error-classifier.ts";
import { getCachedSequence, setCachedSequence, invalidateOrgCache, cacheSize } from "./cache.ts";
import { evaluateJsonPath } from "./jsonpath.ts";
import type { GraphNode } from "../graph/types.ts";

describe("Error classifier", () => {
  it("classifies 401 as auth_expired (non-retryable)", () => {
    const err = classifyHttpError(401, {});
    expect(err.class).toBe("auth_expired");
    expect(err.retryable).toBe(false);
  });

  it("classifies 404 as drift (non-retryable)", () => {
    const err = classifyHttpError(404, {});
    expect(err.class).toBe("drift");
    expect(err.retryable).toBe(false);
  });

  it("classifies 429 as rate_limited (retryable) with Retry-After", () => {
    const err = classifyHttpError(429, { "retry-after": "10" });
    expect(err.class).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(10000);
  });

  it("classifies 429 with default 5s delay when no Retry-After header", () => {
    const err = classifyHttpError(429, {});
    expect(err.class).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(5000);
  });

  it("classifies 500 as server_error (retryable)", () => {
    const err = classifyHttpError(500, {});
    expect(err.class).toBe("server_error");
    expect(err.retryable).toBe(true);
  });

  it("classifies 503 as server_error (retryable)", () => {
    const err = classifyHttpError(503, {});
    expect(err.class).toBe("server_error");
    expect(err.retryable).toBe(true);
  });

  it("classifies 400 as client_error (non-retryable)", () => {
    const err = classifyHttpError(400, {});
    expect(err.class).toBe("client_error");
    expect(err.retryable).toBe(false);
  });

  it("classifyExtractorNull includes jsonpath and field in message", () => {
    const err = classifyExtractorNull("$.id", "invoice_id", { data: { id: null } });
    expect(err.class).toBe("extractor_null");
    expect(err.message).toContain("$.id");
    expect(err.message).toContain("invoice_id");
    expect(err.retryable).toBe(false);
  });
});

describe("Sequence cache", () => {
  beforeEach(() => {
    invalidateOrgCache("org-1");
    invalidateOrgCache("org-2");
  });

  it("returns null for cache miss", () => {
    const result = getCachedSequence("org-1", "submit invoice", 1);
    expect(result).toBeNull();
  });

  it("returns cached sequence on hit", () => {
    const fakeSequence = [{ id: "POST:/invoices", url_template: "/invoices" }] as GraphNode[];
    setCachedSequence("org-1", "submit invoice", 1, fakeSequence);
    const result = getCachedSequence("org-1", "submit invoice", 1);
    expect(result).toEqual(fakeSequence);
  });

  it("returns null when graph_version differs", () => {
    const fakeSequence = [{ id: "POST:/invoices", url_template: "/invoices" }] as GraphNode[];
    setCachedSequence("org-1", "submit invoice", 1, fakeSequence);
    const result = getCachedSequence("org-1", "submit invoice", 2);
    expect(result).toBeNull();
  });

  it("isolates cache by org_id", () => {
    const fakeSequence = [{ id: "POST:/invoices", url_template: "/invoices" }] as GraphNode[];
    setCachedSequence("org-1", "submit invoice", 1, fakeSequence);
    const result = getCachedSequence("org-2", "submit invoice", 1);
    expect(result).toBeNull();
  });

  it("invalidateOrgCache removes all entries for that org", () => {
    const fakeSequence = [{ id: "POST:/invoices", url_template: "/invoices" }] as GraphNode[];
    setCachedSequence("org-1", "submit invoice", 1, fakeSequence);
    setCachedSequence("org-1", "cancel invoice", 1, fakeSequence);
    invalidateOrgCache("org-1");
    expect(getCachedSequence("org-1", "submit invoice", 1)).toBeNull();
    expect(getCachedSequence("org-1", "cancel invoice", 1)).toBeNull();
  });

  it("invalidateOrgCache does not affect other orgs", () => {
    const fakeSequence = [{ id: "POST:/invoices", url_template: "/invoices" }] as GraphNode[];
    setCachedSequence("org-1", "submit invoice", 1, fakeSequence);
    setCachedSequence("org-2", "submit invoice", 1, fakeSequence);
    invalidateOrgCache("org-1");
    expect(getCachedSequence("org-2", "submit invoice", 1)).toEqual(fakeSequence);
  });
});

describe("JSONPath evaluator", () => {
  const data = { id: "inv_123", customer: { name: "Acme", id: "cus_456" }, items: [{ amount: 100 }] };

  it("extracts top-level field", () => {
    expect(evaluateJsonPath(data, "$.id")).toBe("inv_123");
  });

  it("extracts nested field", () => {
    expect(evaluateJsonPath(data, "$.customer.name")).toBe("Acme");
  });

  it("extracts nested id field", () => {
    expect(evaluateJsonPath(data, "$.customer.id")).toBe("cus_456");
  });

  it("extracts array element", () => {
    expect(evaluateJsonPath(data, "$.items[0].amount")).toBe(100);
  });

  it("returns undefined for missing path", () => {
    expect(evaluateJsonPath(data, "$.nonexistent")).toBeUndefined();
  });

  it("returns undefined when traversing into non-object", () => {
    expect(evaluateJsonPath(data, "$.id.nested")).toBeUndefined();
  });

  it("throws for path not starting with $", () => {
    expect(() => evaluateJsonPath(data, "id")).toThrow();
  });
});
