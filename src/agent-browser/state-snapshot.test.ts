import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync } from "fs";
import { join } from "path";

const TEST_HOME = join(process.cwd(), ".tmp-state-snapshots-home");

async function loadStore() {
  vi.resetModules();
  vi.stubEnv("HOME", TEST_HOME);
  return await import("./state-snapshot.ts");
}

describe("state snapshots", () => {
  beforeEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("saves and loads snapshot", async () => {
    const store = await loadStore();
    await store.saveStateSnapshot({
      profile: "demo",
      savedAt: new Date().toISOString(),
      currentUrl: "https://example.com",
      tabs: [{ id: "t1", url: "https://example.com", title: "Example", active: true }],
      cookies: [{ name: "sid", value: "1" }],
      localStorage: { a: "1" },
      sessionStorage: { b: "2" },
    });
    const loaded = await store.loadStateSnapshot("demo");
    expect(loaded?.currentUrl).toBe("https://example.com");
    expect(loaded?.tabs).toHaveLength(1);
    expect(loaded?.cookies).toHaveLength(1);
  });

  it("lists and deletes profiles", async () => {
    const store = await loadStore();
    await store.saveStateSnapshot({
      profile: "one",
      savedAt: new Date().toISOString(),
      tabs: [],
      cookies: [],
      localStorage: {},
      sessionStorage: {},
    });
    await store.saveStateSnapshot({
      profile: "two",
      savedAt: new Date().toISOString(),
      tabs: [],
      cookies: [],
      localStorage: {},
      sessionStorage: {},
    });

    const profiles = await store.listStateSnapshots();
    expect(profiles.sort()).toEqual(["one", "two"]);
    const deleted = await store.deleteStateSnapshot("one");
    expect(deleted).toBe(true);
    const profilesAfter = await store.listStateSnapshots();
    expect(profilesAfter).toEqual(["two"]);
  });
});
