/**
 * Cookie Store — persist browser sessions to disk by profile name.
 * Saves to ~/.sound-browser/cookies/<profile>.json
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import { readdir, unlink } from "fs/promises";

const STORE_DIR = join(homedir(), ".sound-browser", "cookies");
const PROFILE_RE = /^[a-zA-Z0-9._-]{1,80}$/;

function ensureDir() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

function profilePath(profile: string): string {
  if (!PROFILE_RE.test(profile) || profile === "." || profile === "..") {
    throw new Error("Invalid profile name. Use 1-80 letters, numbers, dots, underscores, or hyphens.");
  }
  return join(STORE_DIR, `${profile}.json`);
}

export async function saveCookies(profile: string, cookies: unknown[]): Promise<void> {
  ensureDir();
  const path = profilePath(profile);
  await Bun.write(path, JSON.stringify({ profile, savedAt: new Date().toISOString(), cookies }, null, 2));
}

export async function loadCookies(profile: string): Promise<any[] | null> {
  ensureDir();
  const path = profilePath(profile);
  if (!existsSync(path)) return null;
  const data = JSON.parse(await Bun.file(path).text());
  return data.cookies ?? null;
}

export async function listProfiles(): Promise<string[]> {
  ensureDir();
  const files = await readdir(STORE_DIR);
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export async function deleteProfile(profile: string): Promise<boolean> {
  const path = profilePath(profile);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
