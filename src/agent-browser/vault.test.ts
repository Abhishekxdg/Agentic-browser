import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";

const TEST_VAULT_DIR = join(process.cwd(), ".tmp-vault-tests");

async function loadVault() {
  vi.resetModules();
  vi.stubEnv("SOUND_VAULT_DIR", TEST_VAULT_DIR);
  vi.stubEnv("SOUND_VAULT_KEY", "test-master-key-123");
  return await import("./vault.ts");
}

describe("vault per-user isolation", () => {
  beforeEach(() => {
    if (existsSync(TEST_VAULT_DIR)) rmSync(TEST_VAULT_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(TEST_VAULT_DIR)) rmSync(TEST_VAULT_DIR, { recursive: true, force: true });
  });

  it("isolates same site credentials by user_id", async () => {
    const vault = await loadVault();
    await vault.vaultSet("org1", "github.com", { username: "alice", password: "a" }, "user-a");
    await vault.vaultSet("org1", "github.com", { username: "bob", password: "b" }, "user-b");

    const a = await vault.vaultGet("org1", "github.com", "user-a");
    const b = await vault.vaultGet("org1", "github.com", "user-b");
    expect(a?.username).toBe("alice");
    expect(b?.username).toBe("bob");
  });

  it("lists only selected user when filter present", async () => {
    const vault = await loadVault();
    await vault.vaultSet("org2", "site-a.com", { username: "u1" }, "u1");
    await vault.vaultSet("org2", "site-b.com", { username: "u2" }, "u2");

    const onlyU1 = await vault.vaultList("org2", "u1");
    expect(onlyU1).toHaveLength(1);
    expect(onlyU1[0]?.user_id).toBe("u1");
    expect(onlyU1[0]?.site).toBe("site-a.com");
  });
});
