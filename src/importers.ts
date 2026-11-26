import fs from "node:fs";
import path from "node:path";

import { SCOPE_PRESETS, YOUTUBE_SCOPES } from "./scopes.js";
import {
  YtAuthError,
  isRealYouTubeChannelId,
  slugifyAlias,
  type ClientType,
} from "./types.js";
import { VaultStore } from "./vault.js";

export interface ParsedClientSecrets {
  type: ClientType;
  projectId?: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function parseGoogleClientSecretsFile(filePath: string): ParsedClientSecrets {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new YtAuthError("FILE_NOT_FOUND", `Client secrets file not found: ${abs}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
  const type: ClientType | undefined =
    typeof raw["installed"] === "object" && raw["installed"] !== null
      ? "installed"
      : typeof raw["web"] === "object" && raw["web"] !== null
        ? "web"
        : undefined;

  if (!type) {
    throw new YtAuthError(
      "INVALID_CLIENT_SECRETS",
      `Expected top-level "installed" or "web" key in ${abs}.`,
    );
  }

  const block = raw[type] as {
    client_id?: unknown;
    client_secret?: unknown;
    project_id?: unknown;
    redirect_uris?: unknown;
  };

  if (typeof block.client_id !== "string" || typeof block.client_secret !== "string") {
    throw new YtAuthError(
      "INVALID_CLIENT_SECRETS",
      `Missing client_id or client_secret in ${abs}.`,
    );
  }

  const uris = Array.isArray(block.redirect_uris)
    ? block.redirect_uris.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];

  const redirectUri =
    uris[0] ?? (type === "installed" ? "http://localhost" : "http://localhost:3000/callback");

  return {
    type,
    projectId: typeof block.project_id === "string" ? block.project_id : undefined,
    clientId: block.client_id,
    clientSecret: block.client_secret,
    redirectUri,
  };
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export interface ImportSummary {
  source: "gafv" | "krillin";
  sourceDir: string;
  dryRun: boolean;
  clientImported: string | null;
  imported: Array<{
    alias: string;
    provider: string;
    channelId?: string;
    channelTitle?: string;
    note?: string;
  }>;
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Read-only import of OAuth client, YouTube channels, and Master Drive refresh token from a GAFV repo.
 * Never modifies the source GAFV files or database.
 */
export async function importFromGafv(
  gafvDir: string,
  options?: {
    vaultDir?: string;
    clientAlias?: string;
    workspace?: string;
    googleProfile?: string;
    activeOnly?: boolean;
    dryRun?: boolean;
  },
): Promise<ImportSummary> {
  const absDir = path.resolve(gafvDir);
  const dryRun = Boolean(options?.dryRun);
  const activeOnly = options?.activeOnly ?? true;
  const clientAlias = options?.clientAlias ?? "gafv";
  const workspace = options?.workspace ?? "gafv";
  const store = new VaultStore(options?.vaultDir);

  const envPath = path.join(absDir, ".env.local");
  const envMap = parseDotEnvFile(envPath);
  const clientId = envMap["YOUTUBE_CLIENT_ID"];
  const clientSecret = envMap["YOUTUBE_CLIENT_SECRET"];

  if (!clientId || !clientSecret) {
    throw new YtAuthError(
      "GAFV_ENV_MISSING",
      `Could not find YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in ${envPath}.`,
    );
  }

  const dbCandidates = [
    path.join(absDir, "packages", "db", "gavf.db"),
    path.join(absDir, "gavf.db"),
  ];
  const dbPath = dbCandidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 4096);
  if (!dbPath) {
    throw new YtAuthError(
      "GAFV_DB_MISSING",
      `Could not find populated gavf.db in ${dbCandidates.join(" or ")}.`,
    );
  }

  const summary: ImportSummary = {
    source: "gafv",
    sourceDir: absDir,
    dryRun,
    clientImported: clientAlias,
    imported: [],
    skipped: [],
  };

  if (!dryRun) {
    store.upsertClient({
      alias: clientAlias,
      type: "web",
      clientId,
      clientSecret,
      redirectUri: "http://localhost:3000/api/auth/youtube/callback",
      notes: `Imported read-only from ${envPath}`,
    });
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const netCols = (
      db.prepare("PRAGMA table_info(networks)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    const hasNetStatus = netCols.includes("status");
    const networks = db
      .prepare(
        hasNetStatus
          ? "SELECT id, name, status FROM networks"
          : "SELECT id, name, 'active' AS status FROM networks",
      )
      .all() as Array<{ id: string; name: string; status: string | null }>;
    const networkById = new Map(networks.map((n) => [n.id, n]));

    const channels = db
      .prepare(
        "SELECT id, network_id, platform, channel_name, channel_id, refresh_token, is_active FROM channels WHERE platform = 'youtube'",
      )
      .all() as Array<{
      id: string;
      network_id: string | null;
      platform: string;
      channel_name: string | null;
      channel_id: string | null;
      refresh_token: string | null;
      is_active: number | null;
    }>;

    for (const ch of channels) {
      const label = ch.channel_name ?? ch.channel_id ?? ch.id;
      const net = ch.network_id ? networkById.get(ch.network_id) : undefined;
      const netName = net?.name;
      const netStatus = net?.status ?? "active";

      if (activeOnly && (netStatus !== "active" || ch.is_active === 0)) {
        summary.skipped.push({
          name: label,
          reason: `inactive (network=${netStatus}, channel_active=${ch.is_active ?? 1})`,
        });
        continue;
      }

      if (!ch.refresh_token || ch.refresh_token.trim().length === 0) {
        summary.skipped.push({ name: label, reason: "missing refresh_token" });
        continue;
      }
      const baseSlug = netName
        ? slugifyAlias(netName.replace(/\bnetwork\b/gi, "").replace(/\bto\b/gi, "-"))
        : slugifyAlias(label);
      const alias = `gafv-${baseSlug}`;
      const realChannelId = isRealYouTubeChannelId(ch.channel_id) ? ch.channel_id : undefined;

      if (!dryRun) {
        store.upsertAccount({
          alias,
          provider: "youtube",
          clientAlias,
          channelId: realChannelId,
          channelTitle: ch.channel_name ?? undefined,
          googleProfile: options?.googleProfile,
          workspace,
          permission: "write",
          scopes: [...SCOPE_PRESETS.full],
          refreshToken: ch.refresh_token.trim(),
          notes: `Imported from GAFV (${netName ?? ch.id}, active=${ch.is_active ?? 0})`,
        });
      }

      summary.imported.push({
        alias,
        provider: "youtube",
        channelId: realChannelId,
        channelTitle: ch.channel_name ?? undefined,
        note: netName ? `network=${netName}` : undefined,
      });
    }

    // Master Google Drive token if present
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'")
      .all();
    if (tables.length > 0) {
      const driveRow = db
        .prepare("SELECT value FROM app_settings WHERE key = 'MASTER_DRIVE_REFRESH_TOKEN'")
        .get() as { value: string | null } | undefined;
      if (driveRow?.value && driveRow.value.trim().length > 0) {
        const alias = "gafv-master-drive";
        if (!dryRun) {
          store.upsertAccount({
            alias,
            provider: "google-drive",
            clientAlias,
            googleProfile: options?.googleProfile,
            workspace,
            permission: "write",
            scopes: [...SCOPE_PRESETS.drive],
            refreshToken: driveRow.value.trim(),
            notes: "Imported MASTER_DRIVE_REFRESH_TOKEN from GAFV app_settings",
          });
        }
        summary.imported.push({
          alias,
          provider: "google-drive",
          note: "MASTER_DRIVE_REFRESH_TOKEN",
        });
      }
    }
  } finally {
    db.close();
  }

  return summary;
}

/**
 * Read-only import of OAuth client + per-channel YouTube refresh tokens from a KrillinAI repo.
 * Ignores fake placeholder page_id values so "yt-auth doctor --resolve" can populate real UC... IDs.
 */
export async function importFromKrillin(
  krillinDir: string,
  options?: {
    vaultDir?: string;
    clientAlias?: string;
    workspace?: string;
    googleProfile?: string;
    dryRun?: boolean;
  },
): Promise<ImportSummary> {
  const absDir = path.resolve(krillinDir);
  const dryRun = Boolean(options?.dryRun);
  const clientAlias = options?.clientAlias ?? "krillinai";
  const workspace = options?.workspace ?? "krillinAI";
  const store = new VaultStore(options?.vaultDir);

  const clientSecretsPath = path.join(absDir, "config", "client_secrets.json");
  const parsedClient = parseGoogleClientSecretsFile(clientSecretsPath);

  const dbPath = path.join(absDir, "krillinai.db");
  if (!fs.existsSync(dbPath)) {
    throw new YtAuthError("KRILLIN_DB_MISSING", `Could not find ${dbPath}.`);
  }

  const summary: ImportSummary = {
    source: "krillin",
    sourceDir: absDir,
    dryRun,
    clientImported: clientAlias,
    imported: [],
    skipped: [],
  };

  if (!dryRun) {
    store.upsertClient({
      alias: clientAlias,
      type: parsedClient.type,
      projectId: parsedClient.projectId,
      clientId: parsedClient.clientId,
      clientSecret: parsedClient.clientSecret,
      redirectUri: parsedClient.redirectUri,
      notes: `Imported read-only from ${clientSecretsPath}`,
    });
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const channels = db
      .prepare(
        "SELECT id, name, platform, page_id, access_token, enabled FROM channels WHERE platform = 'youtube'",
      )
      .all() as Array<{
      id: number;
      name: string;
      platform: string;
      page_id: string | null;
      access_token: string | null;
      enabled: number | null;
    }>;

    for (const ch of channels) {
      const tokenRel =
        ch.access_token && ch.access_token.endsWith(".json")
          ? ch.access_token
          : path.join("config", `youtube_token_ch_${ch.id}.json`);
      const tokenPath = path.isAbsolute(tokenRel) ? tokenRel : path.join(absDir, tokenRel);
      if (!fs.existsSync(tokenPath)) {
        summary.skipped.push({ name: ch.name, reason: `token file not found (${tokenRel})` });
        continue;
      }

      let refreshToken: string | undefined;
      try {
        const tokJson = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as {
          refresh_token?: unknown;
        };
        if (typeof tokJson.refresh_token === "string" && tokJson.refresh_token.trim().length > 0) {
          refreshToken = tokJson.refresh_token.trim();
        }
      } catch (err) {
        summary.skipped.push({
          name: ch.name,
          reason: `invalid JSON in ${tokenRel}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      if (!refreshToken) {
        summary.skipped.push({ name: ch.name, reason: `no refresh_token in ${tokenRel}` });
        continue;
      }

      const alias = `krillin-${slugifyAlias(ch.name)}`;
      const realChannelId = isRealYouTubeChannelId(ch.page_id) ? ch.page_id : undefined;

      if (!dryRun) {
        store.upsertAccount({
          alias,
          provider: "youtube",
          clientAlias,
          channelId: realChannelId,
          channelTitle: ch.name,
          googleProfile: options?.googleProfile,
          workspace,
          permission: "write",
          scopes: [YOUTUBE_SCOPES.manage],
          refreshToken,
          notes: `Imported from KrillinAI (ch_id=${ch.id}, enabled=${ch.enabled ?? 0}). Run "yt-auth doctor ${alias} --resolve" to verify & populate real UC channelId.`,
        });
      }

      summary.imported.push({
        alias,
        provider: "youtube",
        channelId: realChannelId,
        channelTitle: ch.name,
        note: realChannelId ? undefined : "channelId pending doctor --resolve",
      });
    }
  } finally {
    db.close();
  }

  return summary;
}
