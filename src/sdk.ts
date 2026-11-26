import {
  google,
  type Auth,
  type drive_v3,
  type youtubeAnalytics_v2,
  type youtube_v3,
} from "googleapis";

import { hasWriteScope } from "./scopes.js";
import {
  VaultGuardError,
  YtAuthError,
  isRealYouTubeChannelId,
  type AccessGuardOptions,
  type DoctorCheckResult,
  type OAuthClientRecord,
  type PublicAccountInfo,
  type VaultAccountRecord,
} from "./types.js";
import { VaultStore, toPublicAccount } from "./vault.js";

export interface OAuthBundle {
  auth: Auth.OAuth2Client;
  account: PublicAccountInfo;
  clientAlias: string;
}

export interface AccessTokenResult {
  alias: string;
  provider: VaultAccountRecord["provider"];
  accessToken: string;
  expiryDate?: number;
  channelId?: string;
  channelTitle?: string;
  handle?: string;
  workspace?: string;
  scopes: string[];
}

export interface YouTubeClientBundle {
  youtube: youtube_v3.Youtube;
  analytics: youtubeAnalytics_v2.Youtubeanalytics;
  auth: Auth.OAuth2Client;
  account: PublicAccountInfo;
}

export interface DriveClientBundle {
  drive: drive_v3.Drive;
  auth: Auth.OAuth2Client;
  account: PublicAccountInfo;
}

export function enforceAccountGuards(
  account: VaultAccountRecord,
  options?: AccessGuardOptions,
): void {
  if (options?.expectedWorkspace && account.workspace !== options.expectedWorkspace) {
    throw new VaultGuardError(
      "WORKSPACE_MISMATCH",
      `Account "${account.alias}" belongs to workspace "${account.workspace ?? "unset"}", not expected workspace "${options.expectedWorkspace}".`,
    );
  }

  if (options?.expectedChannelId) {
    if (!account.channelId) {
      throw new VaultGuardError(
        "CHANNEL_ID_UNVERIFIED",
        `Account "${account.alias}" has no verified channelId in vault. Run "yt-auth doctor ${account.alias} --resolve" first.`,
      );
    }
    if (account.channelId !== options.expectedChannelId) {
      throw new VaultGuardError(
        "EXPECTED_CHANNEL_MISMATCH",
        `Account "${account.alias}" is bound to channelId "${account.channelId}", not expected "${options.expectedChannelId}".`,
      );
    }
  }

  if (options?.requireWrite) {
    if (account.permission !== "write") {
      throw new VaultGuardError(
        "READONLY_ACCOUNT",
        `Account "${account.alias}" is marked permission="readonly". Refusing write-capable client request.`,
      );
    }
    if (!hasWriteScope(account.provider, account.scopes)) {
      throw new VaultGuardError(
        "INSUFFICIENT_SCOPES",
        `Account "${account.alias}" does not have write scopes granted (${account.scopes.join(", ")}). Re-authenticate with --preset studio or --preset full.`,
      );
    }
  }
}

function buildOAuth2Client(client: OAuthClientRecord, account: VaultAccountRecord): Auth.OAuth2Client {
  const auth = new google.auth.OAuth2(client.clientId, client.clientSecret);
  auth.setCredentials({ refresh_token: account.refreshToken });
  return auth;
}

export function listAccounts(filter?: {
  vaultDir?: string;
  workspace?: string;
  provider?: VaultAccountRecord["provider"];
  googleProfile?: string;
}): PublicAccountInfo[] {
  const store = new VaultStore(filter?.vaultDir);
  return store.listAccounts({
    workspace: filter?.workspace,
    provider: filter?.provider,
    googleProfile: filter?.googleProfile,
  });
}

export function getOAuth2Client(alias: string, options?: AccessGuardOptions): OAuthBundle {
  const store = new VaultStore(options?.vaultDir);
  const account = store.getAccount(alias);
  enforceAccountGuards(account, options);
  const client = store.getClient(account.clientAlias);
  const auth = buildOAuth2Client(client, account);
  return {
    auth,
    account: toPublicAccount(account),
    clientAlias: client.alias,
  };
}

export async function getAccessToken(
  alias: string,
  options?: AccessGuardOptions,
): Promise<AccessTokenResult> {
  const { auth, account } = getOAuth2Client(alias, options);
  const tokenResp = await auth.getAccessToken();
  const accessToken = tokenResp.token;
  if (!accessToken) {
    throw new YtAuthError(
      "TOKEN_REFRESH_FAILED",
      `Failed to obtain fresh access_token for alias "${alias}".`,
    );
  }
  const expiryDate =
    typeof auth.credentials.expiry_date === "number" ? auth.credentials.expiry_date : undefined;
  return {
    alias: account.alias,
    provider: account.provider,
    accessToken,
    expiryDate,
    channelId: account.channelId,
    channelTitle: account.channelTitle,
    handle: account.handle,
    workspace: account.workspace,
    scopes: account.scopes,
  };
}

export async function getYouTubeClient(
  alias: string,
  options?: AccessGuardOptions,
): Promise<YouTubeClientBundle> {
  const store = new VaultStore(options?.vaultDir);
  const record = store.getAccount(alias);
  if (record.provider !== "youtube") {
    throw new VaultGuardError(
      "WRONG_PROVIDER",
      `Account "${alias}" has provider="${record.provider}", expected "youtube".`,
    );
  }
  enforceAccountGuards(record, options);
  const client = store.getClient(record.clientAlias);
  const auth = buildOAuth2Client(client, record);
  const youtube = google.youtube({ version: "v3", auth });
  const analytics = google.youtubeAnalytics({ version: "v2", auth });

  if (options?.verifyLiveChannel) {
    const resp = await youtube.channels.list({ part: ["snippet"], mine: true });
    const liveId = resp.data.items?.[0]?.id;
    if (!liveId) {
      throw new VaultGuardError(
        "LIVE_CHANNEL_MISSING",
        `Live YouTube token for "${alias}" returned no channel.`,
      );
    }
    if (options.expectedChannelId && liveId !== options.expectedChannelId) {
      throw new VaultGuardError(
        "LIVE_CHANNEL_MISMATCH",
        `Live YouTube token for "${alias}" resolved to "${liveId}", not expected "${options.expectedChannelId}".`,
      );
    }
    if (record.channelId && liveId !== record.channelId) {
      throw new VaultGuardError(
        "LIVE_CHANNEL_DRIFT",
        `Live YouTube token for "${alias}" resolved to "${liveId}", differing from vault record "${record.channelId}".`,
      );
    }
  }

  return {
    youtube,
    analytics,
    auth,
    account: toPublicAccount(record),
  };
}

export function getDriveClient(alias: string, options?: AccessGuardOptions): DriveClientBundle {
  const store = new VaultStore(options?.vaultDir);
  const record = store.getAccount(alias);
  if (record.provider !== "google-drive") {
    throw new VaultGuardError(
      "WRONG_PROVIDER",
      `Account "${alias}" has provider="${record.provider}", expected "google-drive".`,
    );
  }
  enforceAccountGuards(record, options);
  const client = store.getClient(record.clientAlias);
  const auth = buildOAuth2Client(client, record);
  const drive = google.drive({ version: "v3", auth });
  return {
    drive,
    auth,
    account: toPublicAccount(record),
  };
}

function extractGoogleErrorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof YtAuthError) {
    return { code: err.code, message: err.message };
  }
  if (typeof err === "object" && err !== null) {
    const e = err as {
      code?: unknown;
      message?: unknown;
      response?: { data?: { error?: unknown; error_description?: unknown } };
    };
    const oauthErr = e.response?.data?.error;
    const oauthDesc = e.response?.data?.error_description;
    if (typeof oauthErr === "string") {
      return {
        code: oauthErr,
        message: typeof oauthDesc === "string" ? `${oauthErr}: ${oauthDesc}` : oauthErr,
      };
    }
    return {
      code: typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : "UNKNOWN",
      message: typeof e.message === "string" ? e.message : String(err),
    };
  }
  return { code: "UNKNOWN", message: String(err) };
}

export async function checkDoctor(options?: {
  alias?: string;
  workspace?: string;
  resolve?: boolean;
  vaultDir?: string;
}): Promise<DoctorCheckResult[]> {
  const store = new VaultStore(options?.vaultDir);
  const targets = options?.alias
    ? [store.getAccount(options.alias)]
    : store
        .listAccounts({ workspace: options?.workspace })
        .map((pub) => store.getAccount(pub.alias));

  const results: DoctorCheckResult[] = [];
  for (const record of targets) {
    const result: DoctorCheckResult = {
      alias: record.alias,
      provider: record.provider,
      clientAlias: record.clientAlias,
      workspace: record.workspace,
      ok: false,
      channelId: record.channelId,
      channelTitle: record.channelTitle,
      handle: record.handle,
      accountEmail: record.accountEmail,
    };

    try {
      const client = store.getClient(record.clientAlias);
      const auth = buildOAuth2Client(client, record);
      const tokenResp = await auth.getAccessToken();
      if (!tokenResp.token) {
        throw new YtAuthError("TOKEN_REFRESH_FAILED", "No access_token returned on refresh.");
      }

      if (record.provider === "youtube") {
        const yt = google.youtube({ version: "v3", auth });
        const resp = await yt.channels.list({ part: ["snippet"], mine: true });
        const item = resp.data.items?.[0];
        if (!item?.id) {
          throw new YtAuthError("NO_YOUTUBE_CHANNEL", "Token refreshed, but no YouTube channel found.");
        }
        result.channelId = item.id;
        result.channelTitle = item.snippet?.title ?? result.channelTitle;
        result.handle = item.snippet?.customUrl ?? result.handle;
        result.ok = true;

        if (options?.resolve) {
          store.updateAccountMetadata(
            record.alias,
            {
              channelId: isRealYouTubeChannelId(item.id) ? item.id : record.channelId,
              channelTitle: item.snippet?.title ?? record.channelTitle,
              handle: item.snippet?.customUrl ?? record.handle,
              lastVerifiedAt: new Date().toISOString(),
            },
            { allowDuplicateChannel: false },
          );
          result.resolvedUpdated = true;
        }
      } else {
        const drive = google.drive({ version: "v3", auth });
        const about = await drive.about.get({ fields: "user(emailAddress,displayName)" });
        result.accountEmail = about.data.user?.emailAddress ?? result.accountEmail;
        result.channelTitle = about.data.user?.displayName ?? result.channelTitle;
        result.ok = true;

        if (options?.resolve) {
          store.updateAccountMetadata(record.alias, {
            accountEmail: result.accountEmail,
            channelTitle: result.channelTitle,
            lastVerifiedAt: new Date().toISOString(),
          });
          result.resolvedUpdated = true;
        }
      }
    } catch (err) {
      const info = extractGoogleErrorInfo(err);
      result.ok = false;
      result.errorCode = info.code;
      result.error = info.message;
    }

    results.push(result);
  }

  return results;
}

export async function fetchChannelStats(alias: string, options?: AccessGuardOptions) {
  const { youtube, account } = await getYouTubeClient(alias, options);
  const resp = await youtube.channels.list({
    part: ["snippet", "statistics", "contentDetails", "status"],
    mine: true,
  });
  const ch = resp.data.items?.[0];
  if (!ch) {
    throw new YtAuthError("NO_YOUTUBE_CHANNEL", `No YouTube channel returned for alias "${alias}".`);
  }
  return {
    alias: account.alias,
    workspace: account.workspace,
    channelId: ch.id ?? account.channelId,
    title: ch.snippet?.title ?? account.channelTitle,
    handle: ch.snippet?.customUrl ?? account.handle,
    publishedAt: ch.snippet?.publishedAt,
    country: ch.snippet?.country,
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads,
    privacyStatus: ch.status?.privacyStatus,
    isLinked: ch.status?.isLinked,
    longUploadsStatus: ch.status?.longUploadsStatus,
    statistics: {
      subscriberCount: Number(ch.statistics?.subscriberCount ?? 0),
      viewCount: Number(ch.statistics?.viewCount ?? 0),
      videoCount: Number(ch.statistics?.videoCount ?? 0),
      hiddenSubscriberCount: Boolean(ch.statistics?.hiddenSubscriberCount),
    },
  };
}

export async function fetchRecentVideos(
  alias: string,
  limit = 20,
  options?: AccessGuardOptions,
) {
  const { youtube, account } = await getYouTubeClient(alias, options);
  const chResp = await youtube.channels.list({
    part: ["contentDetails", "snippet"],
    mine: true,
  });
  const ch = chResp.data.items?.[0];
  const uploadsId = ch?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) {
    throw new YtAuthError("NO_UPLOADS_PLAYLIST", `Uploads playlist not found for alias "${alias}".`);
  }

  const clamped = Math.max(1, Math.min(50, limit));
  const plResp = await youtube.playlistItems.list({
    part: ["contentDetails", "snippet"],
    playlistId: uploadsId,
    maxResults: clamped,
  });

  const videoIds = (plResp.data.items ?? [])
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (videoIds.length === 0) {
    return {
      alias: account.alias,
      channelId: ch.id ?? account.channelId,
      channelTitle: ch.snippet?.title ?? account.channelTitle,
      videos: [],
    };
  }

  const vidsResp = await youtube.videos.list({
    part: ["snippet", "status", "statistics", "contentDetails"],
    id: videoIds,
  });

  const videos = (vidsResp.data.items ?? []).map((v) => ({
    videoId: v.id ?? "",
    url: v.id ? `https://youtu.be/${v.id}` : "",
    title: v.snippet?.title ?? "",
    publishedAt: v.snippet?.publishedAt ?? "",
    publishAt: v.status?.publishAt ?? null,
    privacyStatus: v.status?.privacyStatus ?? "",
    duration: v.contentDetails?.duration ?? "",
    viewCount: Number(v.statistics?.viewCount ?? 0),
    likeCount: Number(v.statistics?.likeCount ?? 0),
    commentCount: Number(v.statistics?.commentCount ?? 0),
  }));

  return {
    alias: account.alias,
    channelId: ch.id ?? account.channelId,
    channelTitle: ch.snippet?.title ?? account.channelTitle,
    videos,
  };
}

export interface AnalyticsReportParams {
  days?: number;
  startDate?: string;
  endDate?: string;
  dimension?: "day" | "video";
  metrics?: string[];
  maxResults?: number;
}

function formatYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function fetchAnalyticsReport(
  alias: string,
  params: AnalyticsReportParams = {},
  options?: AccessGuardOptions,
) {
  const { analytics, account } = await getYouTubeClient(alias, options);
  const now = new Date();
  const days = Math.max(1, Math.min(365, params.days ?? 28));
  const endDate = params.endDate ?? formatYmd(now);
  const startDate =
    params.startDate ?? formatYmd(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const dimension = params.dimension ?? "day";
  const metrics =
    params.metrics && params.metrics.length > 0
      ? params.metrics
      : [
          "views",
          "estimatedMinutesWatched",
          "averageViewDuration",
          "averageViewPercentage",
          "subscribersGained",
          "likes",
          "comments",
        ];

  const resp = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    metrics: metrics.join(","),
    dimensions: dimension,
    sort: dimension === "video" ? "-views" : "day",
    maxResults: dimension === "video" ? Math.min(50, params.maxResults ?? 20) : undefined,
  });

  const headers = (resp.data.columnHeaders ?? []).map((h) => h.name ?? "");
  const rows = (resp.data.rows ?? []).map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx];
    });
    return obj;
  });

  return {
    alias: account.alias,
    channelId: account.channelId,
    channelTitle: account.channelTitle,
    startDate,
    endDate,
    dimension,
    headers,
    rowCount: rows.length,
    rows,
  };
}
