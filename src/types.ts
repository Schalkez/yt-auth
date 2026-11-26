import { z } from "zod";

export const ProviderSchema = z.enum(["youtube", "google-drive"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ClientTypeSchema = z.enum(["installed", "web"]);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const PermissionSchema = z.enum(["readonly", "write"]);
export type Permission = z.infer<typeof PermissionSchema>;

export const OAuthClientRecordSchema = z.object({
  alias: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, "Alias must be lowercase kebab/snake case"),
  type: ClientTypeSchema,
  projectId: z.string().optional(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OAuthClientRecord = z.infer<typeof OAuthClientRecordSchema>;

export const VaultAccountRecordSchema = z.object({
  alias: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, "Alias must be lowercase kebab/snake case"),
  provider: ProviderSchema,
  clientAlias: z.string().min(1),
  channelId: z.string().optional(),
  channelTitle: z.string().optional(),
  handle: z.string().optional(),
  accountEmail: z.string().optional(),
  googleProfile: z.string().optional(),
  workspace: z.string().optional(),
  permission: PermissionSchema.default("readonly"),
  scopes: z.array(z.string()).default([]),
  refreshToken: z.string().min(1),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastVerifiedAt: z.string().optional(),
});
export type VaultAccountRecord = z.infer<typeof VaultAccountRecordSchema>;

export const VaultDataSchema = z.object({
  version: z.literal(1),
  clients: z.record(z.string(), OAuthClientRecordSchema).default({}),
  accounts: z.record(z.string(), VaultAccountRecordSchema).default({}),
});
export type VaultData = z.infer<typeof VaultDataSchema>;

/** Sanitized view of an OAuth client (clientSecret redacted). */
export interface PublicClientInfo {
  alias: string;
  type: ClientType;
  projectId?: string;
  clientIdPrefix: string;
  redirectUri: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Sanitized view of an account (refreshToken redacted). */
export interface PublicAccountInfo {
  alias: string;
  provider: Provider;
  clientAlias: string;
  channelId?: string;
  channelTitle?: string;
  handle?: string;
  accountEmail?: string;
  googleProfile?: string;
  workspace?: string;
  permission: Permission;
  scopes: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

export interface AccessGuardOptions {
  /** Vault directory override (defaults to YT_AUTH_HOME or ~/.yt-auth). */
  vaultDir?: string;
  /** Enforce that the stored account matches this exact YouTube channel ID (UC...). */
  expectedChannelId?: string;
  /** Enforce that the stored account belongs to this workspace (e.g. "ai-video-studio", "gafv"). */
  expectedWorkspace?: string;
  /** Require permission === "write" and write-capable scopes. */
  requireWrite?: boolean;
  /** Call YouTube channels.list(mine=true) live to verify token -> channelId binding. */
  verifyLiveChannel?: boolean;
}

export interface DoctorCheckResult {
  alias: string;
  provider: Provider;
  clientAlias: string;
  workspace?: string;
  ok: boolean;
  channelId?: string;
  channelTitle?: string;
  handle?: string;
  accountEmail?: string;
  resolvedUpdated?: boolean;
  error?: string;
  errorCode?: string;
}

export class YtAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "YtAuthError";
    this.code = code;
  }
}

export class VaultGuardError extends YtAuthError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "VaultGuardError";
  }
}

/** Strict check for real YouTube UC channel IDs (24 chars starting with UC). */
export function isRealYouTubeChannelId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(id.trim());
}

/** Convert arbitrary display name into a clean lowercase alias. */
export function slugifyAlias(input: string): string {
  const normalized = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "account";
}
