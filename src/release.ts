import fs from "node:fs";
import path from "node:path";
import type { youtube_v3 } from "googleapis";

const ZERO_DURATION = "P0D";
const PROCESSING_SUCCEEDED = "succeeded";
const DEFAULT_RESTORE_ATTEMPTS = 3;

/**
 * Minimum Analytics-to-Realtime view coverage ratio required before trusting
 * YouTube Analytics API v2 AVD/AVP metrics alongside realtime Data API views.
 * Analytics API typically lags 48–72h behind realtime Data API view counts.
 */
export const ANALYTICS_LAG_MIN_COVERAGE = 0.75;

export interface VideoHealth {
  videoId: string;
  title: string;
  privacyStatus: string;
  publishAt: string;
  uploadStatus: string;
  failureReason: string;
  rejectionReason: string;
  duration: string;
  processingStatus: string;
}

export interface EffectiveStatusResult {
  privacyStatus: string;
  publishAt?: string;
}

export interface OwnCommentMatch {
  commentId: string;
  text: string;
}

export interface SeedCommentResult {
  status: "adopted" | "posted" | "dry_run";
  commentId: string;
  text: string;
}

export interface ParkUnlistedResult<T> {
  parked: boolean;
  restored: boolean;
  restoredPrivacy: string;
  restoredPublishAt: string;
  result: T;
}

export interface AnalyticsFreshnessResult {
  views: number;
  analyticsViews: number | null;
  coverage: number | null;
  analyticsThroughDate: string | null;
  analyticsLagged: boolean;
  avdSec: number | null;
  avdPct: number | null;
  rawAvdSec: number | null;
  rawAvdPct: number | null;
  subsGained: number | null;
  lagNote: string | null;
}

/**
 * Reports whether YouTube actually finished transcoding and accepted a video.
 * Prevents promoting a broken or zero-length (P0D) upload to "published" on privacy alone.
 */
export function isVideoPlayable(health: Partial<VideoHealth> | null | undefined): boolean {
  if (!health) return false;
  if (health.failureReason || health.rejectionReason) return false;
  if (health.processingStatus && health.processingStatus !== PROCESSING_SUCCEEDED) {
    return false;
  }
  return health.duration !== ZERO_DURATION;
}

export function getStuckReason(health: Partial<VideoHealth> | null | undefined): string {
  if (!health) return "missing_health";
  const reasons: string[] = [];
  if (health.failureReason) reasons.push(`failure=${health.failureReason}`);
  if (health.rejectionReason) reasons.push(`rejected=${health.rejectionReason}`);
  if (health.processingStatus && health.processingStatus !== PROCESSING_SUCCEEDED) {
    reasons.push(`processing=${health.processingStatus}`);
  }
  if (health.duration === ZERO_DURATION) reasons.push(`duration=${ZERO_DURATION}`);
  return reasons.join(" ");
}

/**
 * Guards against YouTube 400 Bad Request when restoring a scheduled video whose
 * publishAt timestamp has already passed while parked unlisted.
 */
export function resolveEffectiveStatus(
  targetPrivacy: string,
  publishAtIso?: string,
  now: Date = new Date(),
): EffectiveStatusResult {
  if (!publishAtIso) return { privacyStatus: targetPrivacy, publishAt: undefined };
  const scheduled = new Date(publishAtIso);
  if (!Number.isNaN(scheduled.getTime()) && scheduled.getTime() <= now.getTime()) {
    return { privacyStatus: "public", publishAt: undefined };
  }
  if (Number.isNaN(scheduled.getTime())) {
    return {
      privacyStatus: targetPrivacy === "private" ? "public" : targetPrivacy,
      publishAt: undefined,
    };
  }
  return { privacyStatus: targetPrivacy, publishAt: publishAtIso };
}

export function formatPrivacyObservation(privacyStatus?: string, publishAt?: string): string {
  const p = String(privacyStatus ?? "").toLowerCase();
  if (p === "private" && publishAt) return `scheduled ${publishAt}`;
  return p || "unknown";
}

function normalizeCommentText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Fetches health, privacy, publishAt, and processing state for up to 50 video IDs
 * in a single 1-quota-unit videos.list call.
 */
export async function fetchVideosHealth(
  youtube: Pick<youtube_v3.Youtube, "videos">,
  videoIds: string[],
): Promise<Map<string, VideoHealth>> {
  const cleanIds = [...new Set(videoIds.filter(Boolean))];
  if (cleanIds.length === 0) return new Map();

  const resp = await youtube.videos.list({
    part: ["status", "contentDetails", "processingDetails", "snippet"],
    id: cleanIds,
  });

  const out = new Map<string, VideoHealth>();
  for (const item of resp.data?.items ?? []) {
    if (!item.id) continue;
    out.set(item.id, {
      videoId: item.id,
      title: item.snippet?.title ?? "",
      privacyStatus: item.status?.privacyStatus ?? "",
      publishAt: item.status?.publishAt ?? "",
      uploadStatus: item.status?.uploadStatus ?? "",
      failureReason: item.status?.failureReason ?? "",
      rejectionReason: item.status?.rejectionReason ?? "",
      duration: item.contentDetails?.duration ?? "",
      processingStatus: item.processingDetails?.processingStatus ?? "",
    });
  }
  return out;
}

/**
 * Checks whether our channel already posted a matching top-level comment on videoId
 * (costs 1 quota unit vs 50 for commentThreads.insert — prevents duplicate posts).
 */
export async function findOwnComment(params: {
  youtube: Pick<youtube_v3.Youtube, "commentThreads">;
  videoId: string;
  channelId?: string;
  expectedText?: string;
}): Promise<OwnCommentMatch | null> {
  const { youtube, videoId, channelId, expectedText = "" } = params;
  try {
    const resp = await youtube.commentThreads.list({
      part: ["snippet"],
      videoId,
      maxResults: 50,
    });
    const normTarget = normalizeCommentText(expectedText);
    for (const thread of resp.data?.items ?? []) {
      const top = thread.snippet?.topLevelComment;
      const authorId = top?.snippet?.authorChannelId?.value ?? "";
      if (channelId && authorId !== channelId) continue;
      const actual = normalizeCommentText(
        top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? "",
      );
      if (!normTarget || actual === normTarget) {
        return {
          commentId: top?.id ?? thread.id ?? "",
          text: actual,
        };
      }
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/commentsDisabled|forbidden|403/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

/**
 * Posts a top-level seed comment idempotently (adopts existing channel comment if found).
 * Refuses to call commentThreads.insert on a private video (which flat-403s and burns 50 units).
 */
export async function seedCommentWithDedup(params: {
  youtube: Pick<youtube_v3.Youtube, "commentThreads">;
  videoId: string;
  channelId?: string;
  text: string;
  privacyStatus?: string;
  dryRun?: boolean;
}): Promise<SeedCommentResult> {
  const { youtube, videoId, channelId, text, privacyStatus = "", dryRun = false } = params;
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Seed comment text is empty.");
  if (String(privacyStatus).toLowerCase() === "private") {
    throw new Error(
      `Video ${videoId} is private — YouTube API rejects commentThreads.insert (403). ` +
        "Wait until public or use parkUnlistedAndRun to temporarily park unlisted and restore.",
    );
  }

  const existing = await findOwnComment({ youtube, videoId, channelId, expectedText: cleanText });
  if (existing?.commentId) {
    return { status: "adopted", commentId: existing.commentId, text: existing.text };
  }

  if (dryRun) {
    return { status: "dry_run", commentId: "", text: cleanText };
  }

  const inserted = await youtube.commentThreads.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: { textOriginal: cleanText },
        },
      },
    },
  });
  const commentId = inserted.data?.snippet?.topLevelComment?.id ?? inserted.data?.id ?? "";
  return { status: "posted", commentId, text: cleanText };
}

/**
 * Unlisted Parking Trick:
 * If a video is private (including scheduled with publishAt), temporarily parks it
 * as unlisted, executes fn(), and ALWAYS restores its exact privacy + publishAt in
 * finally (with retry & past-schedule safety so a video is never stranded unlisted).
 */
export async function parkUnlistedAndRun<T>(params: {
  youtube: Pick<youtube_v3.Youtube, "videos">;
  videoId: string;
  originalPrivacy: string;
  originalPublishAt?: string;
  fn: () => Promise<T>;
  nowFn?: () => Date;
  restoreAttempts?: number;
}): Promise<ParkUnlistedResult<T>> {
  const {
    youtube,
    videoId,
    originalPrivacy,
    originalPublishAt = "",
    fn,
    nowFn = () => new Date(),
    restoreAttempts = DEFAULT_RESTORE_ATTEMPTS,
  } = params;

  const isPrivate = String(originalPrivacy || "").toLowerCase() === "private";
  if (!isPrivate) {
    const result = await fn();
    return {
      parked: false,
      restored: false,
      restoredPrivacy: originalPrivacy,
      restoredPublishAt: originalPublishAt,
      result,
    };
  }

  await youtube.videos.update({
    part: ["status"],
    requestBody: {
      id: videoId,
      status: { privacyStatus: "unlisted" },
    },
  });

  let fnResult!: T;
  let fnError: unknown = null;
  let restoreError: unknown = null;
  let restoredPrivacy = "unlisted";
  let restoredPublishAt = "";

  try {
    fnResult = await fn();
  } catch (err) {
    fnError = err;
  } finally {
    const target = resolveEffectiveStatus("private", originalPublishAt, nowFn());
    for (let attempt = 1; attempt <= restoreAttempts; attempt++) {
      try {
        const statusBody: { privacyStatus: string; publishAt?: string } = {
          privacyStatus: target.privacyStatus,
        };
        if (target.publishAt) statusBody.publishAt = target.publishAt;
        await youtube.videos.update({
          part: ["status"],
          requestBody: { id: videoId, status: statusBody },
        });
        restoredPrivacy = target.privacyStatus;
        restoredPublishAt = target.publishAt ?? "";
        restoreError = null;
        break;
      } catch (err) {
        restoreError = err;
      }
    }
  }

  if (restoreError) {
    const restoreMsg = restoreError instanceof Error ? restoreError.message : String(restoreError);
    throw new Error(
      `CRITICAL: Video ${videoId} was parked unlisted and failed to restore after ${restoreAttempts} attempts: ${restoreMsg}`,
    );
  }
  if (fnError) throw fnError;

  return {
    parked: true,
    restored: true,
    restoredPrivacy,
    restoredPublishAt,
    result: fnResult,
  };
}

/** Extract the latest YYYY-MM-DD date present in a dimension="day" Analytics report. */
export function extractLatestAnalyticsDay(dailyReport?: {
  rows?: Array<Record<string, unknown>>;
}): string | null {
  let latest: string | null = null;
  for (const row of dailyReport?.rows ?? []) {
    const day = row?.day;
    if (typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      if (!latest || day > latest) latest = day;
    }
  }
  return latest;
}

/**
 * Guard against mixing realtime Data API views with 48–72h lagged Analytics API AVD/AVP.
 * Withholds top-level avdSec/avdPct whenever Analytics covers < minCoverage of realtime
 * views, while preserving exact diagnostics for notes/CLI output.
 */
export function evaluateAnalyticsFreshness(params: {
  realtimeViews: number;
  analyticsRow?: Record<string, unknown> | null;
  analyticsThroughDate?: string | null;
  minCoverage?: number;
}): AnalyticsFreshnessResult {
  const {
    realtimeViews,
    analyticsRow,
    analyticsThroughDate = null,
    minCoverage = ANALYTICS_LAG_MIN_COVERAGE,
  } = params;

  const analyticsViews =
    typeof analyticsRow?.views === "number" ? analyticsRow.views : null;
  const rawAvdSec =
    typeof analyticsRow?.averageViewDuration === "number"
      ? Math.round(analyticsRow.averageViewDuration)
      : null;
  const rawAvdPct =
    typeof analyticsRow?.averageViewPercentage === "number"
      ? Math.round(analyticsRow.averageViewPercentage * 10) / 10
      : null;
  const subsGained =
    typeof analyticsRow?.subscribersGained === "number"
      ? analyticsRow.subscribersGained
      : null;

  const views = analyticsViews !== null ? Math.max(analyticsViews, realtimeViews) : realtimeViews;
  const coverage =
    realtimeViews > 0 && analyticsViews !== null ? analyticsViews / realtimeViews : null;

  const hasAnalyticsMetrics = rawAvdSec !== null || rawAvdPct !== null;
  const isPartialLag =
    realtimeViews > 0 &&
    analyticsViews !== null &&
    coverage !== null &&
    coverage < minCoverage;
  const isMissingAnalytics = realtimeViews > 0 && (analyticsViews === null || analyticsViews === 0);
  const analyticsLagged = isPartialLag || isMissingAnalytics;

  const throughPart = analyticsThroughDate ? `through ${analyticsThroughDate}` : null;
  let lagNote: string | null = null;

  if (isPartialLag) {
    const pctCov = Math.round(coverage * 100);
    const details = [
      `${pctCov}%`,
      throughPart,
      hasAnalyticsMetrics ? `raw_avd=${rawAvdSec ?? "?"}s/${rawAvdPct ?? "?"}%` : null,
    ].filter(Boolean);
    lagNote = `analytics_lagged=${analyticsViews}/${realtimeViews}v (${details.join(", ")})`;
  } else if (isMissingAnalytics) {
    lagNote = `analytics_pending=0/${realtimeViews}v${throughPart ? ` (${throughPart})` : ""}`;
  } else if (analyticsViews !== null && realtimeViews > 0) {
    lagNote = `analytics=${analyticsViews}/${realtimeViews}v${throughPart ? ` (${throughPart})` : ""}`;
  }

  return {
    views,
    analyticsViews,
    coverage,
    analyticsThroughDate,
    analyticsLagged,
    avdSec: analyticsLagged ? null : rawAvdSec,
    avdPct: analyticsLagged ? null : rawAvdPct,
    rawAvdSec,
    rawAvdPct,
    subsGained,
    lagNote,
  };
}

export interface UploadVideoParams {
  youtube: Pick<youtube_v3.Youtube, "videos">;
  filePath: string;
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  privacyStatus?: "private" | "unlisted" | "public";
  publishAt?: string;
  selfDeclaredMadeForKids?: boolean;
  containsSyntheticMedia?: boolean;
}

/**
 * Resumable YouTube video upload helper (uses Node fs stream; supports private,
 * unlisted parking, or scheduled publishAt).
 */
export async function uploadVideo(params: UploadVideoParams): Promise<{
  videoId: string;
  url: string;
  privacyStatus: string;
  publishAt: string;
}> {
  const {
    youtube,
    filePath,
    title,
    description,
    tags = [],
    categoryId = "28",
    defaultLanguage,
    defaultAudioLanguage,
    privacyStatus = "private",
    publishAt,
    selfDeclaredMadeForKids = false,
    containsSyntheticMedia = false,
  } = params;

  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Video file not found: ${abs}`);
  }

  const status: youtube_v3.Schema$VideoStatus = {
    privacyStatus: publishAt ? "private" : privacyStatus,
    selfDeclaredMadeForKids,
    containsSyntheticMedia,
  };
  if (publishAt) status.publishAt = publishAt;

  const snippet: youtube_v3.Schema$VideoSnippet = {
    title,
    description,
    tags,
    categoryId,
  };
  if (defaultLanguage) snippet.defaultLanguage = defaultLanguage;
  if (defaultAudioLanguage) snippet.defaultAudioLanguage = defaultAudioLanguage;

  const resp = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: { snippet, status },
    media: {
      mimeType: "video/mp4",
      body: fs.createReadStream(abs),
    },
  });

  const videoId = resp.data?.id ?? "";
  if (!videoId) throw new Error("YouTube videos.insert returned no video ID.");
  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    privacyStatus: resp.data?.status?.privacyStatus ?? status.privacyStatus ?? "private",
    publishAt: resp.data?.status?.publishAt ?? publishAt ?? "",
  };
}

/** Uploads a custom JPEG/PNG thumbnail (< 2 MB) to a YouTube video. */
export async function setVideoThumbnail(params: {
  youtube: Pick<youtube_v3.Youtube, "thumbnails">;
  videoId: string;
  imagePath: string;
}): Promise<{ videoId: string; imagePath: string; bytes: number }> {
  const abs = path.resolve(params.imagePath);
  if (!fs.existsSync(abs)) throw new Error(`Thumbnail file not found: ${abs}`);
  const stat = fs.statSync(abs);
  if (stat.size >= 2 * 1024 * 1024) {
    throw new Error(`Thumbnail exceeds YouTube 2 MB limit (${stat.size} bytes): ${abs}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  await params.youtube.thumbnails.set({
    videoId: params.videoId,
    media: {
      mimeType,
      body: fs.createReadStream(abs),
    },
  });
  return { videoId: params.videoId, imagePath: abs, bytes: stat.size };
}

/** Uploads an SRT/VTT caption track to a YouTube video. */
export async function uploadCaptionTrack(params: {
  youtube: Pick<youtube_v3.Youtube, "captions">;
  videoId: string;
  captionPath: string;
  language: string;
  name?: string;
  isDraft?: boolean;
}): Promise<{ captionId: string; videoId: string; language: string }> {
  const abs = path.resolve(params.captionPath);
  if (!fs.existsSync(abs)) throw new Error(`Caption file not found: ${abs}`);
  const resp = await params.youtube.captions.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        videoId: params.videoId,
        language: params.language,
        name: params.name ?? "",
        isDraft: params.isDraft ?? false,
      },
    },
    media: {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(abs),
    },
  });
  return {
    captionId: resp.data?.id ?? "",
    videoId: params.videoId,
    language: params.language,
  };
}

