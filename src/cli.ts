#!/usr/bin/env node
import { spawn } from "node:child_process";

import { Command } from "commander";

import {
  importFromGafv,
  importFromKrillin,
  parseGoogleClientSecretsFile,
} from "./importers.js";
import { startMcpServer } from "./mcp.js";
import { runLoopbackLogin } from "./oauth.js";
import { defaultPermissionForPreset, resolveScopes, SCOPE_PRESETS } from "./scopes.js";
import {
  checkDoctor,
  fetchAnalyticsReport,
  fetchChannelStats,
  fetchRecentVideos,
  getAccessToken,
  getYouTubeClient,
  listAccounts,
} from "./sdk.js";
import {
  fetchVideosHealth,
  getStuckReason,
  isVideoPlayable,
  parkUnlistedAndRun,
  seedCommentWithDedup,
} from "./release.js";
import type { ClientType, Permission, Provider } from "./types.js";
import { VaultStore, toPublicAccount } from "./vault.js";

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function openUrlInBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? "cmd"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

const program = new Command();

program
  .name("yt-ops")
  .description(
    "Centralized multi-channel YouTube & Google Drive operations kit: encrypted OAuth vault, release/analytics SDK, CLI, and read-only MCP server.",
  )
  .version("0.2.0")
  .option("--vault-dir <dir>", "Override vault directory (defaults to YT_OPS_HOME, YT_AUTH_HOME, ~/.yt-ops, or ~/.yt-auth)");

function vaultDirOf(): string | undefined {
  const opts = program.opts<{ vaultDir?: string }>();
  return opts.vaultDir;
}

// ============================================================================
// client subcommands
// ============================================================================
const clientCmd = program.command("client").description("Manage Google Cloud OAuth clients");

clientCmd
  .command("add <alias>")
  .description("Register an OAuth client manually (installed/desktop or web)")
  .requiredOption("--client-id <id>", "Google OAuth Client ID")
  .requiredOption("--client-secret <secret>", "Google OAuth Client Secret")
  .option("--type <type>", "Client type: installed | web", "installed")
  .option("--redirect-uri <uri>", "Registered redirect URI")
  .option("--project-id <projectId>", "Optional GCP project ID label")
  .option("--notes <notes>", "Optional notes")
  .option("--json", "Output JSON")
  .action((alias: string, opts) => {
    const type = (opts.type === "web" ? "web" : "installed") as ClientType;
    const redirectUri =
      (opts.redirectUri as string | undefined) ??
      (type === "installed" ? "http://localhost" : "http://localhost:3000/api/auth/youtube/callback");
    const store = new VaultStore(vaultDirOf());
    const saved = store.upsertClient({
      alias,
      type,
      projectId: opts.projectId as string | undefined,
      clientId: opts.clientId as string,
      clientSecret: opts.clientSecret as string,
      redirectUri,
      notes: opts.notes as string | undefined,
    });
    if (opts.json) {
      printJson(saved);
    } else {
      console.log(`Saved OAuth client "${saved.alias}" (${saved.type}) -> ${saved.redirectUri}`);
    }
  });

clientCmd
  .command("import-json <alias> <file>")
  .description("Import a Google Cloud Console client_secrets.json file")
  .option("--redirect-uri <uri>", "Override redirect URI")
  .option("--notes <notes>", "Optional notes")
  .option("--json", "Output JSON")
  .action((alias: string, file: string, opts) => {
    const parsed = parseGoogleClientSecretsFile(file);
    const store = new VaultStore(vaultDirOf());
    const saved = store.upsertClient({
      alias,
      type: parsed.type,
      projectId: parsed.projectId,
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      redirectUri: (opts.redirectUri as string | undefined) ?? parsed.redirectUri,
      notes: opts.notes as string | undefined,
    });
    if (opts.json) {
      printJson(saved);
    } else {
      console.log(
        `Imported OAuth client "${saved.alias}" (${saved.type}, project=${saved.projectId ?? "unknown"}) -> ${saved.redirectUri}`,
      );
    }
  });

clientCmd
  .command("list")
  .description("List registered OAuth clients (secrets redacted)")
  .option("--json", "Output JSON")
  .action((opts) => {
    const store = new VaultStore(vaultDirOf());
    const clients = store.listClients();
    if (opts.json) {
      printJson(clients);
      return;
    }
    if (clients.length === 0) {
      console.log(`No OAuth clients in ${store.dir}.`);
      return;
    }
    for (const c of clients) {
      console.log(
        `${c.alias.padEnd(16)} type=${c.type.padEnd(9)} id=${c.clientIdPrefix} redirect=${c.redirectUri}`,
      );
    }
  });

clientCmd
  .command("remove <alias>")
  .description("Remove an OAuth client")
  .option("--force", "Remove even if accounts still reference this client")
  .action((alias: string, opts) => {
    const store = new VaultStore(vaultDirOf());
    store.removeClient(alias, Boolean(opts.force));
    console.log(`Removed client "${alias}".`);
  });

// ============================================================================
// login (one-time interactive loopback -> permanent headless refresh_token)
// ============================================================================
program
  .command("login <alias>")
  .description(
    "Authorize a YouTube channel or Google Drive account once via loopback OAuth and store its refresh token",
  )
  .requiredOption("--client <clientAlias>", "Registered OAuth client alias")
  .option("--provider <provider>", "youtube | google-drive", "youtube")
  .option(
    "--preset <preset>",
    `Scope preset (${Object.keys(SCOPE_PRESETS).join(", ")}) or comma-separated scope URLs`,
    "analytics",
  )
  .option("--permission <perm>", "Account guard permission: readonly | write")
  .option("--workspace <workspace>", "Owning workspace (e.g. ai-video-studio, gafv, krillinAI)")
  .option("--profile <googleProfile>", "Chrome/Google profile label (e.g. studio@example.com)")
  .option("--expected-channel <channelId>", "Abort if authorized channel does not match this UC... ID")
  .option("--notes <notes>", "Optional notes")
  .option("--timeout <seconds>", "Callback timeout in seconds", "300")
  .option("--allow-duplicate-channel", "Allow binding a UC channel already bound to another alias")
  .option("--open", "Auto-open default browser (off by default so you can pick the exact Chrome profile)")
  .option("--json", "Output final saved record as JSON")
  .action(async (alias: string, opts) => {
    const provider = (opts.provider === "google-drive" ? "google-drive" : "youtube") as Provider;
    const presetStr = String(opts.preset);
    const scopes = resolveScopes(
      provider === "google-drive" && presetStr === "analytics" ? "drive" : presetStr,
    );
    const permission = (opts.permission ??
      defaultPermissionForPreset(presetStr)) as Permission;

    const result = await runLoopbackLogin({
      alias,
      clientAlias: String(opts.client),
      provider,
      scopes,
      permission,
      workspace: opts.workspace as string | undefined,
      googleProfile: opts.profile as string | undefined,
      expectedChannelId: opts.expectedChannel as string | undefined,
      notes: opts.notes as string | undefined,
      timeoutMs: Number(opts.timeout) * 1000,
      allowDuplicateChannel: Boolean(opts.allowDuplicateChannel),
      vaultDir: vaultDirOf(),
      onAuthUrl: ({ url, redirectUri }) => {
        if (!opts.json) {
          console.log(`\nListening for OAuth callback on: ${redirectUri}`);
          console.log(
            `Open this URL in the exact Chrome profile holding "${alias}"${opts.profile ? ` (${opts.profile})` : ""}:\n`,
          );
          console.log(url);
          console.log("");
        } else {
          process.stderr.write(`AUTH_URL=${url}\nREDIRECT_URI=${redirectUri}\n`);
        }
        if (opts.open) {
          openUrlInBrowser(url);
        }
      },
    });

    if (opts.json) {
      printJson(result.account);
    } else {
      console.log(
        `Connected "${result.account.alias}" -> ${result.account.channelTitle ?? result.account.accountEmail ?? "ok"} ` +
          `(${result.account.channelId ?? result.account.provider}, permission=${result.account.permission})`,
      );
    }
  });

// ============================================================================
// list / show / update / remove
// ============================================================================
program
  .command("list")
  .description("List consolidated accounts in the vault (tokens redacted)")
  .option("--workspace <workspace>", "Filter by workspace")
  .option("--provider <provider>", "Filter by provider (youtube | google-drive)")
  .option("--profile <googleProfile>", "Filter by Google profile label")
  .option("--json", "Output JSON")
  .action((opts) => {
    const accounts = listAccounts({
      vaultDir: vaultDirOf(),
      workspace: opts.workspace as string | undefined,
      provider: opts.provider as Provider | undefined,
      googleProfile: opts.profile as string | undefined,
    });
    if (opts.json) {
      printJson(accounts);
      return;
    }
    if (accounts.length === 0) {
      console.log("No accounts stored in vault yet.");
      return;
    }
    for (const a of accounts) {
      console.log(
        `${a.alias.padEnd(26)} ${(a.workspace ?? "-").padEnd(16)} ${a.permission.padEnd(8)} ` +
          `${(a.channelId ?? a.accountEmail ?? "(unverified)").padEnd(26)} ${a.channelTitle ?? ""}`,
      );
    }
  });

program
  .command("show <alias>")
  .description("Show metadata for a single vault account (token redacted)")
  .option("--json", "Output JSON")
  .action((alias: string, opts) => {
    const store = new VaultStore(vaultDirOf());
    const pub = toPublicAccount(store.getAccount(alias));
    if (opts.json) {
      printJson(pub);
    } else {
      console.log(JSON.stringify(pub, null, 2));
    }
  });

program
  .command("update <alias>")
  .description("Update metadata/guards (workspace, profile, permission, notes) for an account")
  .option("--workspace <workspace>", "Set workspace")
  .option("--profile <googleProfile>", "Set Google/Chrome profile label")
  .option("--permission <perm>", "Set permission: readonly | write")
  .option("--notes <notes>", "Set notes")
  .option("--json", "Output JSON")
  .action((alias: string, opts) => {
    const store = new VaultStore(vaultDirOf());
    const patch: Record<string, unknown> = {};
    if (opts.workspace !== undefined) patch["workspace"] = String(opts.workspace);
    if (opts.profile !== undefined) patch["googleProfile"] = String(opts.profile);
    if (opts.permission !== undefined) patch["permission"] = opts.permission as Permission;
    if (opts.notes !== undefined) patch["notes"] = String(opts.notes);
    const updated = store.updateAccountMetadata(alias, patch);
    if (opts.json) {
      printJson(updated);
    } else {
      console.log(`Updated "${updated.alias}" (workspace=${updated.workspace ?? "-"}, permission=${updated.permission}).`);
    }
  });

program
  .command("remove <alias>")
  .description("Remove an account from the vault")
  .action((alias: string) => {
    const store = new VaultStore(vaultDirOf());
    store.removeAccount(alias);
    console.log(`Removed account "${alias}".`);
  });

// ============================================================================
// token (headless bridge for Go / Python / curl / scripts)
// ============================================================================
program
  .command("token <alias>")
  .description("Print a fresh short-lived access_token (auto-refreshed) for Go/Python/shell scripts")
  .option("--expected-channel <channelId>", "Enforce exact UC... channelId guard")
  .option("--workspace <workspace>", "Enforce workspace guard")
  .option("--require-write", "Enforce write permission & scopes")
  .option("--json", "Output JSON with expiry and channel metadata")
  .action(async (alias: string, opts) => {
    const tok = await getAccessToken(alias, {
      vaultDir: vaultDirOf(),
      expectedChannelId: opts.expectedChannel as string | undefined,
      expectedWorkspace: opts.workspace as string | undefined,
      requireWrite: Boolean(opts.requireWrite),
    });
    if (opts.json) {
      printJson(tok);
    } else {
      process.stdout.write(`${tok.accessToken}\n`);
    }
  });

// ============================================================================
// doctor
// ============================================================================
program
  .command("doctor [alias]")
  .description("Verify refresh tokens live against Google APIs and optionally resolve missing channelIds")
  .option("--workspace <workspace>", "Filter by workspace")
  .option("--resolve", "Save resolved UC channelId, channelTitle, and handle back into the vault")
  .option("--json", "Output JSON")
  .action(async (alias: string | undefined, opts) => {
    const results = await checkDoctor({
      alias,
      workspace: opts.workspace as string | undefined,
      resolve: Boolean(opts.resolve),
      vaultDir: vaultDirOf(),
    });
    if (opts.json) {
      printJson(results);
    } else {
      for (const r of results) {
        const mark = r.ok ? "OK  " : "FAIL";
        const detail = r.ok
          ? `${r.channelId ?? r.accountEmail ?? ""} ${r.channelTitle ?? ""}${r.resolvedUpdated ? " [saved]" : ""}`
          : `[${r.errorCode ?? "ERR"}] ${r.error ?? "unknown error"}`;
        console.log(`${mark} ${r.alias.padEnd(26)} ${detail}`);
      }
    }
    if (results.some((r) => !r.ok)) {
      process.exitCode = 1;
    }
  });

// ============================================================================
// import (one-way read-only migration from gafv / krillinAI)
// ============================================================================
const importCmd = program
  .command("import")
  .description("Import existing tokens read-only from GAFV or KrillinAI without re-logging in");

importCmd
  .command("gafv")
  .description("Import OAuth client, active YouTube channels, and Master Drive token from a GAFV repo")
  .option("--dir <path>", "Path to GAFV repo", "../gafv")
  .option("--client-alias <alias>", "Client alias in vault", "gafv")
  .option("--profile <googleProfile>", "Optional Chrome/Google profile label")
  .option("--include-paused", "Also import channels from paused/inactive GAFV networks")
  .option("--dry-run", "Preview without writing to vault")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    const summary = await importFromGafv(String(opts.dir), {
      vaultDir: vaultDirOf(),
      clientAlias: String(opts.clientAlias),
      googleProfile: opts.profile as string | undefined,
      activeOnly: !Boolean(opts.includePaused),
      dryRun: Boolean(opts.dryRun),
    });
    if (opts.json) {
      printJson(summary);
    } else {
      console.log(
        `${summary.dryRun ? "[DRY-RUN] " : ""}Imported ${summary.imported.length} account(s) from GAFV (skipped ${summary.skipped.length}):`,
      );
      for (const item of summary.imported) {
        console.log(`  + ${item.alias} (${item.provider}) ${item.channelId ?? ""} ${item.channelTitle ?? ""}`);
      }
      for (const s of summary.skipped) {
        console.log(`  - skipped ${s.name}: ${s.reason}`);
      }
    }
  });

importCmd
  .command("krillin")
  .description("Import OAuth client and channel tokens from a KrillinAI repo")
  .option("--dir <path>", "Path to KrillinAI repo", "../krillinAI")
  .option("--client-alias <alias>", "Client alias in vault", "krillinai")
  .option("--profile <googleProfile>", "Optional Chrome/Google profile label")
  .option("--dry-run", "Preview without writing to vault")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    const summary = await importFromKrillin(String(opts.dir), {
      vaultDir: vaultDirOf(),
      clientAlias: String(opts.clientAlias),
      googleProfile: opts.profile as string | undefined,
      dryRun: Boolean(opts.dryRun),
    });
    if (opts.json) {
      printJson(summary);
    } else {
      console.log(
        `${summary.dryRun ? "[DRY-RUN] " : ""}Imported ${summary.imported.length} account(s) from KrillinAI (skipped ${summary.skipped.length}):`,
      );
      for (const item of summary.imported) {
        console.log(
          `  + ${item.alias} (${item.provider}) ${item.channelId ?? "(run doctor --resolve)"} ${item.channelTitle ?? ""}`,
        );
      }
      for (const s of summary.skipped) {
        console.log(`  - skipped ${s.name}: ${s.reason}`);
      }
    }
  });

// ============================================================================
// yt (headless YouTube Data + Analytics queries for agents)
// ============================================================================
const ytCmd = program.command("yt").description("Headless read-only YouTube Data & Analytics queries");

ytCmd
  .command("stats <alias>")
  .description("Fetch live channel stats")
  .option("--expected-channel <channelId>", "Channel ID guard")
  .option("--workspace <workspace>", "Workspace guard")
  .action(async (alias: string, opts) => {
    const data = await fetchChannelStats(alias, {
      vaultDir: vaultDirOf(),
      expectedChannelId: opts.expectedChannel as string | undefined,
      expectedWorkspace: opts.workspace as string | undefined,
    });
    printJson(data);
  });

ytCmd
  .command("videos <alias>")
  .description("List recent videos with URLs, privacy status, and stats")
  .option("--limit <n>", "Max videos (1-50)", "20")
  .option("--expected-channel <channelId>", "Channel ID guard")
  .option("--workspace <workspace>", "Workspace guard")
  .action(async (alias: string, opts) => {
    const data = await fetchRecentVideos(alias, Number(opts.limit), {
      vaultDir: vaultDirOf(),
      expectedChannelId: opts.expectedChannel as string | undefined,
      expectedWorkspace: opts.workspace as string | undefined,
    });
    printJson(data);
  });

ytCmd
  .command("analytics <alias>")
  .description("Query YouTube Analytics v2 report")
  .option("--days <n>", "Lookback days (default 28)", "28")
  .option("--start <YYYY-MM-DD>", "Start date")
  .option("--end <YYYY-MM-DD>", "End date")
  .option("--dimension <dim>", "day | video", "day")
  .option("--max-results <n>", "Max rows when dimension=video", "20")
  .option("--expected-channel <channelId>", "Channel ID guard")
  .option("--workspace <workspace>", "Workspace guard")
  .action(async (alias: string, opts) => {
    const data = await fetchAnalyticsReport(
      alias,
      {
        days: Number(opts.days),
        startDate: opts.start as string | undefined,
        endDate: opts.end as string | undefined,
        dimension: opts.dimension === "video" ? "video" : "day",
        maxResults: Number(opts.maxResults),
      },
      {
        vaultDir: vaultDirOf(),
        expectedChannelId: opts.expectedChannel as string | undefined,
        expectedWorkspace: opts.workspace as string | undefined,
      },
    );
    printJson(data);
  });

ytCmd
  .command("health <alias> <videoIds...>")
  .description("Check playability (processingStatus, P0D guard), privacy, and schedule for video IDs")
  .option("--expected-channel <channelId>", "Channel ID guard")
  .option("--workspace <workspace>", "Workspace guard")
  .action(async (alias: string, videoIds: string[], opts) => {
    const { youtube, account } = await getYouTubeClient(alias, {
      vaultDir: vaultDirOf(),
      expectedChannelId: opts.expectedChannel as string | undefined,
      expectedWorkspace: opts.workspace as string | undefined,
      requireWrite: false,
      verifyLiveChannel: true,
    });
    const map = await fetchVideosHealth(youtube, videoIds);
    const videos = videoIds.map((id) => {
      const h = map.get(id);
      if (!h) return { videoId: id, missing: true, playable: false };
      const playable = isVideoPlayable(h);
      return { ...h, playable, stuckReason: playable ? "" : getStuckReason(h) };
    });
    printJson({ alias: account.alias, channelId: account.channelId, videos });
  });

ytCmd
  .command("seed-comment <alias> <videoId>")
  .description("Post a top-level comment with deduplication (optional --park-unlisted for scheduled/private videos)")
  .requiredOption("--text <text>", "Comment text to post")
  .option("--park-unlisted", "Temporarily park a private/scheduled video as unlisted, post, and restore exact schedule")
  .option("--dry-run", "Inspect without posting")
  .option("--expected-channel <channelId>", "Channel ID guard")
  .option("--workspace <workspace>", "Workspace guard")
  .action(async (alias: string, videoId: string, opts) => {
    const dryRun = Boolean(opts.dryRun);
    const parkUnlisted = Boolean(opts.parkUnlisted);
    const { youtube, account } = await getYouTubeClient(alias, {
      vaultDir: vaultDirOf(),
      expectedChannelId: opts.expectedChannel as string | undefined,
      expectedWorkspace: opts.workspace as string | undefined,
      requireWrite: !dryRun,
      verifyLiveChannel: true,
    });
    const map = await fetchVideosHealth(youtube, [videoId]);
    const h = map.get(videoId);
    if (!h) throw new Error(`Video ${videoId} not found.`);
    if (h.privacyStatus === "private" && parkUnlisted && !dryRun) {
      const res = await parkUnlistedAndRun({
        youtube,
        videoId,
        originalPrivacy: h.privacyStatus,
        originalPublishAt: h.publishAt,
        fn: () =>
          seedCommentWithDedup({
            youtube,
            videoId,
            channelId: account.channelId,
            text: String(opts.text),
            privacyStatus: "unlisted",
          }),
      });
      printJson(res);
    } else {
      const res = await seedCommentWithDedup({
        youtube,
        videoId,
        channelId: account.channelId,
        text: String(opts.text),
        privacyStatus: h.privacyStatus,
        dryRun,
      });
      printJson(res);
    }
  });

// ============================================================================
// mcp (agent-first stdio MCP server)
// ============================================================================
program
  .command("mcp")
  .description("Start the read-only stdio MCP server for Antigravity, Claude Code, or Cursor")
  .action(async () => {
    await startMcpServer({ vaultDir: vaultDirOf() });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
