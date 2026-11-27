import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_LAG_MIN_COVERAGE,
  evaluateAnalyticsFreshness,
  extractLatestAnalyticsDay,
  getStuckReason,
  isVideoPlayable,
  parkUnlistedAndRun,
  resolveEffectiveStatus,
  seedCommentWithDedup,
  setVideoThumbnail,
  uploadCaptionTrack,
} from "../src/release.js";

describe("yt-auth release & analytics primitives", () => {
  it("validates video playability and reports stuck reasons", () => {
    expect(isVideoPlayable({ duration: "PT12M10S", processingStatus: "succeeded" })).toBe(true);
    expect(isVideoPlayable({ duration: "P0D", processingStatus: "succeeded" })).toBe(false);
    expect(isVideoPlayable({ duration: "PT5M", processingStatus: "processing" })).toBe(false);
    expect(isVideoPlayable({ duration: "PT5M", failureReason: "codec" })).toBe(false);
    expect(getStuckReason({ duration: "P0D", processingStatus: "processing" })).toContain("duration=P0D");
  });

  it("resolves past vs future scheduled timestamps safely", () => {
    const now = new Date("2026-11-28T00:05:00Z");
    expect(resolveEffectiveStatus("private", "2026-11-28T00:00:00Z", now)).toEqual({
      privacyStatus: "public",
      publishAt: undefined,
    });
    expect(resolveEffectiveStatus("private", "2026-11-28T01:00:00Z", now)).toEqual({
      privacyStatus: "private",
      publishAt: "2026-11-28T01:00:00Z",
    });
  });

  it("deduplicates comments and refuses private inserts", async () => {
    const inserted: unknown[] = [];
    const youtube = {
      commentThreads: {
        list: async () => ({
          data: {
            items: [
              {
                id: "t1",
                snippet: {
                  topLevelComment: {
                    id: "c_existing",
                    snippet: {
                      authorChannelId: { value: "UC-1" },
                      textOriginal: "Debate   question?",
                    },
                  },
                },
              },
            ],
          },
        }),
        insert: async (req: unknown) => {
          inserted.push(req);
          return { data: { id: "c_new", snippet: { topLevelComment: { id: "c_new" } } } };
        },
      },
    } as never;

    await expect(
      seedCommentWithDedup({
        youtube,
        videoId: "vid12345678",
        channelId: "UC-1",
        text: "New prompt",
        privacyStatus: "private",
      }),
    ).rejects.toThrow(/private/i);

    const adopted = await seedCommentWithDedup({
      youtube,
      videoId: "vid12345678",
      channelId: "UC-1",
      text: "Debate question?",
      privacyStatus: "public",
    });
    expect(adopted.status).toBe("adopted");
    expect(adopted.commentId).toBe("c_existing");
    expect(inserted).toHaveLength(0);

    const posted = await seedCommentWithDedup({
      youtube,
      videoId: "vid12345678",
      channelId: "UC-1",
      text: "Different prompt",
      privacyStatus: "unlisted",
    });
    expect(posted.status).toBe("posted");
    expect(posted.commentId).toBe("c_new");
    expect(inserted).toHaveLength(1);
  });

  it("parks unlisted, runs fn, and always restores schedule even on failure", async () => {
    const updates: unknown[] = [];
    const youtube = {
      videos: {
        update: async (req: { requestBody?: { status?: unknown } }) => {
          updates.push(req.requestBody?.status);
          return { data: {} };
        },
      },
    } as never;

    await expect(
      parkUnlistedAndRun({
        youtube,
        videoId: "lpgSl4jjCqY",
        originalPrivacy: "private",
        originalPublishAt: "2026-11-28T05:00:00Z",
        nowFn: () => new Date("2026-11-27T16:00:00Z"),
        fn: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(updates).toEqual([
      { privacyStatus: "unlisted" },
      { privacyStatus: "private", publishAt: "2026-11-28T05:00:00Z" },
    ]);
  });

  it("withholds lagged Analytics AVD when coverage is below threshold", () => {
    expect(ANALYTICS_LAG_MIN_COVERAGE).toBe(0.75);
    expect(extractLatestAnalyticsDay({ rows: [{ day: "2026-11-23" }, { day: "2026-11-24" }] })).toBe(
      "2026-11-24",
    );

    const lagged = evaluateAnalyticsFreshness({
      realtimeViews: 500,
      analyticsRow: { views: 200, averageViewDuration: 120, averageViewPercentage: 31.4 },
      analyticsThroughDate: "2026-11-24",
    });
    expect(lagged.analyticsLagged).toBe(true);
    expect(lagged.avdSec).toBeNull();
    expect(lagged.avdPct).toBeNull();
    expect(lagged.lagNote).toContain("40%");

    const fresh = evaluateAnalyticsFreshness({
      realtimeViews: 500,
      analyticsRow: { views: 450, averageViewDuration: 185, averageViewPercentage: 47.6 },
      analyticsThroughDate: "2026-11-26",
    });
    expect(fresh.analyticsLagged).toBe(false);
    expect(fresh.avdSec).toBe(185);
    expect(fresh.avdPct).toBe(47.6);
  });

  it("enforces < 2 MB thumbnail guard and uploads caption tracks cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-ops-media-"));
    try {
      const thumbPath = path.join(dir, "ok.png");
      fs.writeFileSync(thumbPath, Buffer.alloc(1024));
      const bigThumb = path.join(dir, "huge.png");
      fs.writeFileSync(bigThumb, Buffer.alloc(2 * 1024 * 1024 + 10));
      const srtPath = path.join(dir, "sub.srt");
      fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:02,000\nHello\n");

      const calls: string[] = [];
      const drain = async (body?: AsyncIterable<unknown>) => {
        if (!body) return;
        for await (const _chunk of body) {
          // drain file stream cleanly before temp dir cleanup
        }
      };
      const fakeYt = {
        thumbnails: {
          set: async ({ videoId, media }: { videoId: string; media?: { body?: AsyncIterable<unknown> } }) => {
            await drain(media?.body);
            calls.push(`thumb:${videoId}`);
            return { data: {} };
          },
        },
        captions: {
          insert: async ({ media }: { media?: { body?: AsyncIterable<unknown> } }) => {
            await drain(media?.body);
            calls.push("caption");
            return { data: { id: "cap_1" } };
          },
        },
      } as never;

      await expect(
        setVideoThumbnail({ youtube: fakeYt, videoId: "vid12345678", imagePath: bigThumb }),
      ).rejects.toThrow(/2 MB/i);

      const tRes = await setVideoThumbnail({
        youtube: fakeYt,
        videoId: "vid12345678",
        imagePath: thumbPath,
      });
      expect(tRes.bytes).toBe(1024);

      const cRes = await uploadCaptionTrack({
        youtube: fakeYt,
        videoId: "vid12345678",
        captionPath: srtPath,
        language: "en",
      });
      expect(cRes.captionId).toBe("cap_1");
      expect(calls).toEqual(["thumb:vid12345678", "caption"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
