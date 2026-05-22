import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const TEST_AUDIT_DIR = join(process.cwd(), ".tmp-audit-tests");

async function loadAuditModule() {
  vi.resetModules();
  vi.stubEnv("AUDIT_DIR", TEST_AUDIT_DIR);
  return await import("./audit.ts");
}

describe("audit chain + export", () => {
  beforeEach(() => {
    if (existsSync(TEST_AUDIT_DIR)) rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(TEST_AUDIT_DIR)) rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
  });

  it("writes hash-linked entries and verifies chain", async () => {
    const audit = await loadAuditModule();
    audit.writeAuditEntry(
      "sess_1",
      "org_1",
      "https://example.com",
      { type: "navigate", url: "https://example.com" } as any,
      { success: true } as any,
    );
    audit.writeAuditEntry(
      "sess_1",
      "org_1",
      "https://example.com",
      { type: "click", target: "Submit" } as any,
      { success: true } as any,
    );
    const check = audit.verifyAuditChain("org_1");
    expect(check.ok).toBe(true);
    expect(check.checked).toBe(2);
  });

  it("detects tampered audit file", async () => {
    const audit = await loadAuditModule();
    audit.writeAuditEntry(
      "sess_2",
      "org_2",
      "https://example.com",
      { type: "navigate", url: "https://example.com" } as any,
      { success: true } as any,
    );
    audit.writeAuditEntry(
      "sess_2",
      "org_2",
      "https://example.com",
      { type: "click", target: "Delete account" } as any,
      { success: true } as any,
    );

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(TEST_AUDIT_DIR, "org_2", `${date}.jsonl`);
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const second = JSON.parse(lines[1]!);
    second.action_detail = "tampered";
    lines[1] = JSON.stringify(second);
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const check = audit.verifyAuditChain("org_2");
    expect(check.ok).toBe(false);
    expect(check.error).toContain("mismatch");
  });

  it("exports csv with headers", async () => {
    const audit = await loadAuditModule();
    audit.writeAuditEntry(
      "sess_3",
      "org_3",
      "https://example.com",
      { type: "fill", form: "login", field: "email", value: "x@y.com" } as any,
      { success: true } as any,
    );
    const csv = audit.exportAuditLog("org_3", { format: "csv" });
    expect(csv.split("\n")[0]).toContain("entry_hash");
    expect(csv).toContain("org_3");
  });
});
