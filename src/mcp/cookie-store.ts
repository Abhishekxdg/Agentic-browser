/**
 * Cookie Store — persist browser sessions to disk by profile name.
 * Saves to ~/.agent-browser/cookies/<profile>.json
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";

const STORE_DIR = join(homedir(), ".agent-browser", "cookies");

function ensureDir() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

export async function saveCookies(profile: string, cookies: unknown[]): Promise<void> {
  ensureDir();
  const path = join(STORE_DIR, `${profile}.json`);
  await Bun.write(path, JSON.stringify({ profile, savedAt: new Date().toISOString(), cookies }, null, 2));
}

export async function loadCookies(profile: string): Promise<any[] | null> {
  ensureDir();
  const path = join(STORE_DIR, `${profile}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(await Bun.file(path).text());
  return data.cookies ?? null;
}

export async function listProfiles(): Promise<string[]> {
  ensureDir();
  const files = await Array.fromAsync(
    (await import("fs")).promises.readdir(STORE_DIR)
  );
  return files
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(".json", ""));
}

export async function deleteProfile(profile: string): Promise<boolean> {
  const path = join(STORE_DIR, `${profile}.json`);
  if (!existsSync(path)) return false;
  await (await import("fs")).promises.unlink(path);
  return true;
}
