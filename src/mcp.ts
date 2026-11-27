import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  checkDoctor,
  fetchAnalyticsReport,
  fetchChannelStats,
  fetchRecentVideos,
  getYouTubeClient,
  listAccounts,
} from "./sdk.js";
import { fetchVideosHealth, getStuckReason, isVideoPlayable } from "./release.js";
import { VaultStore } from "./vault.js";

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}

/**
 * Starts a read-only stdio MCP server exposing consolidated YouTube vault inspection,
 * token health checks, channel stats, recent videos, and YouTube Analytics reports.
 * Never exposes refresh_token, access_token, or client_secret to MCP clients.
 */
export async function startMcpServer(options?: { vaultDir?: string }): Promise<void> {
  const server = new McpServer({
    name: "yt-ops",
    version: "0.2.0",
  });

  const vaultDir = options?.vaultDir;

  server.tool(
    "yt_list_accounts",
    "List all YouTube channels and Google Drive accounts registered in the central yt-auth vault (tokens redacted).",
    {
      workspace: z.string().optional().describe("Filter by workspace (e.g. ai-video-studio, gafv, krillinAI)"),
      provider: z.enum(["youtube", "google-drive"]).optional().describe("Filter by provider"),
      googleProfile: z.string().optional().describe("Filter by Chrome/Google profile label"),
    },
    async ({ workspace, provider, googleProfile }) => {
      try {
        const store = new VaultStore(vaultDir);
        const accounts = listAccounts({ vaultDir, workspace, provider, googleProfile });
        const clients = store.listClients();
        return jsonResult({ vaultDir: store.dir, clients, accounts });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "yt_doctor",
    "Verify OAuth refresh token health for one alias or all accounts in the vault. Optionally resolves and updates missing channelId/title/handle.",
    {
      alias: z.string().optional().describe("Single account alias to verify; omit to verify all accounts"),
      workspace: z.string().optional().describe("Filter accounts by workspace when alias is omitted"),
      resolve: z
        .boolean()
        .optional()
        .describe("If true, save resolved real UC channelId, title, and handle back into the vault"),
    },
    async ({ alias, workspace, resolve }) => {
      try {
        const results = await checkDoctor({ alias, workspace, resolve, vaultDir });
        return jsonResult({
          checked: results.length,
          healthy: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "yt_channel_stats",
    "Fetch live YouTube channel metadata and statistics (subscribers, views, video count, uploads playlist) for a vault alias.",
    {
      alias: z.string().describe("Vault alias of the YouTube channel"),
      expectedChannelId: z
        .string()
        .optional()
        .describe("Optional UC... channelId guard to prevent querying the wrong channel"),
      expectedWorkspace: z.string().optional().describe("Optional workspace guard"),
    },
    async ({ alias, expectedChannelId, expectedWorkspace }) => {
      try {
        const stats = await fetchChannelStats(alias, {
          vaultDir,
          expectedChannelId,
          expectedWorkspace,
        });
        return jsonResult(stats);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "yt_list_videos",
    "List recent uploaded videos (ID, URL, title, privacyStatus, publishedAt, duration, views, likes, comments) for a YouTube vault alias.",
    {
      alias: z.string().describe("Vault alias of the YouTube channel"),
      limit: z.number().int().min(1).max(50).optional().describe("Max videos to return (1-50, default 20)"),
      expectedChannelId: z.string().optional().describe("Optional UC... channelId guard"),
      expectedWorkspace: z.string().optional().describe("Optional workspace guard"),
    },
    async ({ alias, limit, expectedChannelId, expectedWorkspace }) => {
      try {
        const data = await fetchRecentVideos(alias, limit ?? 20, {
          vaultDir,
          expectedChannelId,
          expectedWorkspace,
        });
        return jsonResult(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "yt_analytics_report",
    "Query YouTube Analytics API v2 (views, watch time, averageViewDuration, averageViewPercentage, subscribersGained, likes, comments) by day or by video.",
    {
      alias: z.string().describe("Vault alias of the YouTube channel"),
      days: z.number().int().min(1).max(365).optional().describe("Lookback window in days (default 28)"),
      startDate: z.string().optional().describe("Override start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("Override end date YYYY-MM-DD"),
      dimension: z.enum(["day", "video"]).optional().describe("Breakdown dimension (default: day)"),
      maxResults: z.number().int().min(1).max(50).optional().describe("Max rows when dimension=video"),
      expectedChannelId: z.string().optional().describe("Optional UC... channelId guard"),
      expectedWorkspace: z.string().optional().describe("Optional workspace guard"),
    },
    async ({
      alias,
      days,
      startDate,
      endDate,
      dimension,
      maxResults,
      expectedChannelId,
      expectedWorkspace,
    }) => {
      try {
        const report = await fetchAnalyticsReport(
          alias,
          { days, startDate, endDate, dimension, maxResults },
          { vaultDir, expectedChannelId, expectedWorkspace },
        );
        return jsonResult(report);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "yt_video_health",
    "Check YouTube video playability (processingStatus, P0D duration guard), privacyStatus, and publishAt schedule for 1-50 video IDs in a single 1-quota-unit call.",
    {
      alias: z.string().describe("Vault alias of the YouTube channel"),
      videoIds: z.array(z.string()).min(1).max(50).describe("YouTube video IDs to inspect"),
      expectedChannelId: z.string().optional().describe("Optional UC... channelId guard"),
      expectedWorkspace: z.string().optional().describe("Optional workspace guard"),
    },
    async ({ alias, videoIds, expectedChannelId, expectedWorkspace }) => {
      try {
        const { youtube, account } = await getYouTubeClient(alias, {
          vaultDir,
          expectedChannelId,
          expectedWorkspace,
          requireWrite: false,
        });
        const healthMap = await fetchVideosHealth(youtube, videoIds);
        const videos = videoIds.map((id) => {
          const h = healthMap.get(id);
          if (!h) return { videoId: id, missing: true, playable: false };
          const playable = isVideoPlayable(h);
          return { ...h, playable, stuckReason: playable ? "" : getStuckReason(h) };
        });
        return jsonResult({ alias: account.alias, channelId: account.channelId, videos });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
