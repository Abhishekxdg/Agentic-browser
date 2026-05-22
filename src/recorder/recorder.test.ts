import { describe, it, expect } from "vitest";
import { normalizeUrlTemplate, extractQueryParams } from "./url-normalizer.ts";

describe("URL normalization", () => {
  it("normalizes numeric IDs", () => {
    expect(normalizeUrlTemplate("https://api.example.com/invoices/12345/line_items"))
      .toBe("https://api.example.com/invoices/:param/line_items");
  });

  it("normalizes UUID v4", () => {
    expect(normalizeUrlTemplate("https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000"))
      .toBe("https://api.example.com/users/:param");
  });

  it("normalizes MongoDB ObjectId (24 hex)", () => {
    expect(normalizeUrlTemplate("https://api.example.com/documents/507f1f77bcf86cd799439011"))
      .toBe("https://api.example.com/documents/:param");
  });

  it("normalizes Stripe-style prefixed IDs", () => {
    expect(normalizeUrlTemplate("https://api.stripe.com/v1/invoices/inv_1234abcd5678"))
      .toBe("https://api.stripe.com/v1/invoices/:param");
  });

  it("preserves semantic path segments", () => {
    expect(normalizeUrlTemplate("https://api.example.com/v1/invoices/submit"))
      .toBe("https://api.example.com/v1/invoices/submit");
  });

  it("preserves admin segment (not treated as ID)", () => {
    expect(normalizeUrlTemplate("https://api.example.com/users/admin/settings"))
      .toBe("https://api.example.com/users/admin/settings");
  });

  it("strips query string from template", () => {
    expect(normalizeUrlTemplate("https://api.example.com/search?q=foo&page=2"))
      .toBe("https://api.example.com/search");
  });

  it("handles multiple IDs in path", () => {
    expect(normalizeUrlTemplate("https://api.example.com/orgs/99/users/42/posts/abc123def456789012345678"))
      .toBe("https://api.example.com/orgs/:param/users/:param/posts/:param");
  });

  it("handles malformed URL gracefully", () => {
    const result = normalizeUrlTemplate("not-a-url");
    expect(result).toBe("not-a-url");
  });
});

describe("Query param extraction", () => {
  it("extracts query params", () => {
    const params = extractQueryParams("https://api.example.com/search?q=invoice&status=draft&limit=50");
    expect(params).toEqual({ q: "invoice", status: "draft", limit: "50" });
  });

  it("returns empty object for URL without query params", () => {
    const params = extractQueryParams("https://api.example.com/invoices");
    expect(params).toEqual({});
  });

  it("returns empty object for malformed URL", () => {
    const params = extractQueryParams("not-a-url");
    expect(params).toEqual({});
  });
});
