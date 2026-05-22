/**
 * Credential Vault — encrypted storage for site credentials.
 * AES-256-GCM encryption. Master key derived from AGENT_VAULT_KEY env var.
 * Stored at ~/.agent-browser/vault/<org_id>.json (encrypted).
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { createHmac } from "crypto";

const VAULT_DIR = join(homedir(), ".agent-browser", "vault");

export interface VaultCredential {
  site: string;
  username?: string;
  password?: string;
  totp_secret?: string;
  api_key?: string;
  cookies?: Record<string, string>;
  notes?: string;
  created_at: string;
  updated_at: string;
}

type VaultStore = Record<string, VaultCredential>; // site → credential

// Derive encryption key from master key using PBKDF2-like approach via HMAC
function deriveKey(masterKey: string): Uint8Array {
  const salt = "agent-browser-vault-v1";
  const hmac = createHmac("sha256", masterKey);
  hmac.update(salt);
  return new Uint8Array(hmac.digest());
}

// AES-256-GCM encrypt using Web Crypto (available in Bun/Node)
async function encrypt(plaintext: string, key: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
  // Pack: base64(iv) + "." + base64(ciphertext)
  const ivB64 = Buffer.from(iv).toString("base64");
  const ctB64 = Buffer.from(ciphertext).toString("base64");
  return `${ivB64}.${ctB64}`;
}

// AES-256-GCM decrypt
async function decrypt(packed: string, key: Uint8Array): Promise<string> {
  const [ivB64, ctB64] = packed.split(".");
  if (!ivB64 || !ctB64) throw new Error("Invalid vault format");
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

function vaultPath(orgId: string): string {
  const safe = orgId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(VAULT_DIR, `${safe}.vault`);
}

function ensureDir(): void {
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });
}

function getMasterKey(): string {
  const key = process.env.AGENT_VAULT_KEY;
  if (!key) throw new Error("AGENT_VAULT_KEY environment variable not set. Set it to a strong secret key.");
  return key;
}

export async function vaultSet(
  orgId: string,
  site: string,
  credential: Omit<VaultCredential, "site" | "created_at" | "updated_at">,
): Promise<void> {
  ensureDir();
  const key = deriveKey(getMasterKey());
  const store = await vaultLoad(orgId);
  const now = new Date().toISOString();
  const existing = store[site];
  store[site] = {
    ...credential,
    site,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const encrypted = await encrypt(JSON.stringify(store), key);
  writeFileSync(vaultPath(orgId), encrypted, "utf8");
}

export async function vaultGet(orgId: string, site: string): Promise<VaultCredential | null> {
  const store = await vaultLoad(orgId);
  return store[site] ?? null;
}

export async function vaultDelete(orgId: string, site: string): Promise<boolean> {
  const store = await vaultLoad(orgId);
  if (!store[site]) return false;
  delete store[site];
  const key = deriveKey(getMasterKey());
  const encrypted = await encrypt(JSON.stringify(store), key);
  writeFileSync(vaultPath(orgId), encrypted, "utf8");
  return true;
}

export async function vaultList(orgId: string): Promise<Array<{ site: string; username?: string; has_password: boolean; has_totp: boolean; updated_at: string }>> {
  const store = await vaultLoad(orgId);
  return Object.values(store).map((c) => ({
    site: c.site,
    username: c.username,
    has_password: !!c.password,
    has_totp: !!c.totp_secret,
    updated_at: c.updated_at,
  }));
}

async function vaultLoad(orgId: string): Promise<VaultStore> {
  const path = vaultPath(orgId);
  if (!existsSync(path)) return {};
  try {
    const key = deriveKey(getMasterKey());
    const encrypted = readFileSync(path, "utf8");
    const plaintext = await decrypt(encrypted, key);
    return JSON.parse(plaintext) as VaultStore;
  } catch {
    return {};
  }
}

// Generate TOTP code from stored secret (same algorithm as semantic-auth.ts)
export function generateTOTP(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secretUpper = secret.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of secretUpper) {
    const val = base32Chars.indexOf(char);
    if (val >= 0) bits += val.toString(2).padStart(5, "0");
  }
  const keyBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    const byte = bits.slice(i, i + 8);
    if (byte.length === 8) keyBytes.push(parseInt(byte, 2));
  }
  const msg = Buffer.alloc(8);
  let temp = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = temp & 0xff; temp >>= 8; }
  const hash = createHmac("sha1", Buffer.from(keyBytes)).update(msg).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const code = (((hash[offset]! & 0x7f) << 24) | ((hash[offset + 1]! & 0xff) << 16) | ((hash[offset + 2]! & 0xff) << 8) | (hash[offset + 3]! & 0xff)) % 1000000;
  return code.toString().padStart(6, "0");
}
