import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Resolve the 32-byte master key for the local vault.
 * Priority:
 *  1. YT_AUTH_MASTER_KEY env var (64-char hex string, ideal for CI/VPS)
 *  2. <vaultDir>/master.key (auto-generated on first write with 0600 mode)
 */
export function resolveMasterKey(vaultDir: string, createIfMissing: boolean): Buffer | null {
  const envKey = (process.env["YT_OPS_MASTER_KEY"] ?? process.env["YT_AUTH_MASTER_KEY"])?.trim();
  if (envKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error("YT_OPS_MASTER_KEY / YT_AUTH_MASTER_KEY must be a 64-character hex string (32 bytes).");
    }
    return Buffer.from(envKey, "hex");
  }

  const keyPath = path.join(vaultDir, "master.key");
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(`Corrupted vault key file at ${keyPath}`);
    }
    return Buffer.from(raw, "hex");
  }

  if (!createIfMissing) {
    return null;
  }

  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyPath, `${key.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Best-effort on Windows NTFS
  }
  return key;
}

export function encryptJson(payload: unknown, key: Buffer): EncryptedEnvelope {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptJson<T>(envelope: EncryptedEnvelope, key: Buffer): T {
  if (envelope.v !== 1 || envelope.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported vault envelope version/alg: ${String(envelope.v)}/${String(envelope.alg)}`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
