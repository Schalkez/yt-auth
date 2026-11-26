import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decryptJson, encryptJson, resolveMasterKey, type EncryptedEnvelope } from "./crypto.js";
import {
  OAuthClientRecordSchema,
  VaultAccountRecordSchema,
  VaultDataSchema,
  VaultGuardError,
  YtAuthError,
  isRealYouTubeChannelId,
  type OAuthClientRecord,
  type PublicAccountInfo,
  type PublicClientInfo,
  type VaultAccountRecord,
  type VaultData,
} from "./types.js";

const VAULT_FILENAME = "vault.enc.json";

export function resolveVaultDir(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim().length > 0) {
    return path.resolve(overrideDir.trim());
  }
  const fromEnv = process.env["YT_AUTH_HOME"]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".yt-auth");
}

function emptyVault(): VaultData {
  return { version: 1, clients: {}, accounts: {} };
}

export function toPublicClient(c: OAuthClientRecord): PublicClientInfo {
  return {
    alias: c.alias,
    type: c.type,
    projectId: c.projectId,
    clientIdPrefix: `${c.clientId.slice(0, 14)}...`,
    redirectUri: c.redirectUri,
    notes: c.notes,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function toPublicAccount(a: VaultAccountRecord): PublicAccountInfo {
  return {
    alias: a.alias,
    provider: a.provider,
    clientAlias: a.clientAlias,
    channelId: a.channelId,
    channelTitle: a.channelTitle,
    handle: a.handle,
    accountEmail: a.accountEmail,
    googleProfile: a.googleProfile,
    workspace: a.workspace,
    permission: a.permission,
    scopes: [...a.scopes],
    notes: a.notes,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    lastVerifiedAt: a.lastVerifiedAt,
  };
}

export class VaultStore {
  readonly dir: string;
  readonly filePath: string;

  constructor(overrideDir?: string) {
    this.dir = resolveVaultDir(overrideDir);
    this.filePath = path.join(this.dir, VAULT_FILENAME);
  }

  load(): VaultData {
    if (!fs.existsSync(this.filePath)) {
      return emptyVault();
    }
    const key = resolveMasterKey(this.dir, false);
    if (!key) {
      throw new YtAuthError(
        "MISSING_MASTER_KEY",
        `Vault file exists at ${this.filePath} but master.key (or YT_AUTH_MASTER_KEY) is missing.`,
      );
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as EncryptedEnvelope;
    const decrypted = decryptJson<unknown>(raw, key);
    return VaultDataSchema.parse(decrypted);
  }

  save(data: VaultData): void {
    const validated = VaultDataSchema.parse(data);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = resolveMasterKey(this.dir, true);
    if (!key) {
      throw new YtAuthError("MASTER_KEY_INIT_FAILED", "Unable to initialize vault master key.");
    }
    const envelope = encryptJson(validated, key);
    const tmpPath = path.join(
      this.dir,
      `${VAULT_FILENAME}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort on Windows NTFS
    }
  }

  listClients(): PublicClientInfo[] {
    const data = this.load();
    return Object.values(data.clients)
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map(toPublicClient);
  }

  getClient(alias: string): OAuthClientRecord {
    const data = this.load();
    const record = data.clients[alias];
    if (!record) {
      throw new YtAuthError(
        "CLIENT_NOT_FOUND",
        `OAuth client "${alias}" not found in vault (${this.filePath}). Run "yt-auth client add" or "yt-auth client import-json" first.`,
      );
    }
    return record;
  }

  upsertClient(
    input: Omit<OAuthClientRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): PublicClientInfo {
    const data = this.load();
    const now = new Date().toISOString();
    const existing = data.clients[input.alias];
    const record = OAuthClientRecordSchema.parse({
      ...input,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });
    data.clients[record.alias] = record;
    this.save(data);
    return toPublicClient(record);
  }

  removeClient(alias: string, force = false): void {
    const data = this.load();
    if (!data.clients[alias]) {
      throw new YtAuthError("CLIENT_NOT_FOUND", `OAuth client "${alias}" does not exist.`);
    }
    const dependents = Object.values(data.accounts)
      .filter((a) => a.clientAlias === alias)
      .map((a) => a.alias);
    if (dependents.length > 0 && !force) {
      throw new VaultGuardError(
        "CLIENT_IN_USE",
        `OAuth client "${alias}" is referenced by accounts: ${dependents.join(", ")}. Pass --force to remove anyway.`,
      );
    }
    delete data.clients[alias];
    this.save(data);
  }

  listAccounts(filter?: {
    workspace?: string;
    provider?: VaultAccountRecord["provider"];
    googleProfile?: string;
  }): PublicAccountInfo[] {
    const data = this.load();
    return Object.values(data.accounts)
      .filter((a) => {
        if (filter?.workspace && a.workspace !== filter.workspace) return false;
        if (filter?.provider && a.provider !== filter.provider) return false;
        if (filter?.googleProfile && a.googleProfile !== filter.googleProfile) return false;
        return true;
      })
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map(toPublicAccount);
  }

  getAccount(alias: string): VaultAccountRecord {
    const data = this.load();
    const record = data.accounts[alias];
    if (!record) {
      throw new YtAuthError(
        "ACCOUNT_NOT_FOUND",
        `Account alias "${alias}" not found in vault (${this.filePath}). Run "yt-auth list" to see available aliases.`,
      );
    }
    return record;
  }

  findByChannelId(channelId: string): VaultAccountRecord | undefined {
    const data = this.load();
    return Object.values(data.accounts).find(
      (a) => a.provider === "youtube" && a.channelId === channelId,
    );
  }

  upsertAccount(
    input: Omit<VaultAccountRecord, "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
    options?: { allowDuplicateChannel?: boolean },
  ): PublicAccountInfo {
    const data = this.load();
    if (!data.clients[input.clientAlias]) {
      throw new YtAuthError(
        "CLIENT_NOT_FOUND",
        `Cannot save account "${input.alias}": OAuth client "${input.clientAlias}" does not exist.`,
      );
    }

    // Cross-brand channel conflict protection (prevents binding 1 UC channel to 2 different aliases by mistake)
    if (
      input.provider === "youtube" &&
      isRealYouTubeChannelId(input.channelId) &&
      !options?.allowDuplicateChannel
    ) {
      const conflict = Object.values(data.accounts).find(
        (a) =>
          a.provider === "youtube" &&
          a.channelId === input.channelId &&
          a.alias !== input.alias,
      );
      if (conflict) {
        throw new VaultGuardError(
          "CHANNEL_ID_CONFLICT",
          `YouTube channel "${input.channelTitle ?? input.channelId}" (${input.channelId}) is already bound to alias "${conflict.alias}" (workspace: ${conflict.workspace ?? "none"}). ` +
            `You may have picked the wrong Brand Channel in Google's chooser. Update "${conflict.alias}" instead, or pass allowDuplicateChannel if intentional.`,
        );
      }
    }

    const now = new Date().toISOString();
    const existing = data.accounts[input.alias];
    const record = VaultAccountRecordSchema.parse({
      ...input,
      // Preserve existing refreshToken if re-consent omitted one (empty string won't pass schema anyway)
      refreshToken: input.refreshToken || existing?.refreshToken,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });

    data.accounts[record.alias] = record;
    this.save(data);
    return toPublicAccount(record);
  }

  updateAccountMetadata(
    alias: string,
    patch: Partial<
      Pick<
        VaultAccountRecord,
        | "channelId"
        | "channelTitle"
        | "handle"
        | "accountEmail"
        | "googleProfile"
        | "workspace"
        | "permission"
        | "notes"
        | "lastVerifiedAt"
        | "scopes"
      >
    >,
    options?: { allowDuplicateChannel?: boolean },
  ): PublicAccountInfo {
    const existing = this.getAccount(alias);
    return this.upsertAccount(
      {
        ...existing,
        ...patch,
      },
      options,
    );
  }

  removeAccount(alias: string): void {
    const data = this.load();
    if (!data.accounts[alias]) {
      throw new YtAuthError("ACCOUNT_NOT_FOUND", `Account alias "${alias}" does not exist.`);
    }
    delete data.accounts[alias];
    this.save(data);
  }
}
