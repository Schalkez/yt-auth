import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { google } from "googleapis";

import {
  VaultGuardError,
  YtAuthError,
  isRealYouTubeChannelId,
  type OAuthClientRecord,
  type Permission,
  type Provider,
  type PublicAccountInfo,
} from "./types.js";
import { VaultStore } from "./vault.js";

export interface InteractiveLoginOptions {
  alias: string;
  clientAlias: string;
  provider: Provider;
  scopes: string[];
  permission: Permission;
  googleProfile?: string;
  workspace?: string;
  expectedChannelId?: string;
  notes?: string;
  timeoutMs?: number;
  allowDuplicateChannel?: boolean;
  vaultDir?: string;
  onAuthUrl?: (info: { url: string; redirectUri: string }) => void;
}

export interface InteractiveLoginResult {
  account: PublicAccountInfo;
  redirectUri: string;
  refreshedChannelVerification: boolean;
}

function resolveLoopbackBinding(client: OAuthClientRecord): {
  host: string;
  port: number;
  callbackPath: string;
  buildRedirectUri: (boundPort: number) => string;
} {
  const parsed = new URL(client.redirectUri);
  if (client.type === "installed") {
    // Desktop / Installed apps accept any ephemeral loopback port per Google OAuth spec (RFC 8252).
    const callbackPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/callback";
    return {
      host: "127.0.0.1",
      port: 0,
      callbackPath,
      buildRedirectUri: (boundPort) => `http://127.0.0.1:${boundPort}${callbackPath}`,
    };
  }

  // Web clients require exact registered host, port, and callback path (e.g. http://localhost:3000/api/auth/youtube/callback).
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
  const callbackPath = parsed.pathname || "/";
  return {
    host,
    port,
    callbackPath,
    buildRedirectUri: () => client.redirectUri,
  };
}

function renderHtmlPage(title: string, body: string, ok: boolean): string {
  const accent = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:64px auto;padding:24px;color:#111;line-height:1.5">
  <h2 style="color:${accent};margin-top:0">${title}</h2>
  <p>${body}</p>
  <p style="color:#666;font-size:13px">You can close this browser tab now.</p>
</body>
</html>`;
}

export async function runLoopbackLogin(
  options: InteractiveLoginOptions,
): Promise<InteractiveLoginResult> {
  const store = new VaultStore(options.vaultDir);
  const client = store.getClient(options.clientAlias);
  const binding = resolveLoopbackBinding(client);
  const state = crypto.randomBytes(16).toString("hex");
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (reqUrl.pathname !== binding.callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const errorParam = reqUrl.searchParams.get("error");
      const returnedState = reqUrl.searchParams.get("state");
      const code = reqUrl.searchParams.get("code");

      if (errorParam) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtmlPage("OAuth Denied", `Google returned error: ${errorParam}`, false));
        rejectCode(new YtAuthError("OAUTH_DENIED", `Google OAuth denied: ${errorParam}`));
        return;
      }

      if (!returnedState || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtmlPage("Invalid State", "CSRF state parameter mismatch.", false));
        rejectCode(new YtAuthError("OAUTH_STATE_MISMATCH", "OAuth state mismatch."));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtmlPage("Missing Code", "Authorization code missing from callback.", false));
        rejectCode(new YtAuthError("OAUTH_MISSING_CODE", "Missing OAuth authorization code."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        renderHtmlPage(
          "Authorization Received",
          `Connected alias <code>${options.alias}</code>. Verifying identity and saving encrypted refresh token in terminal...`,
          true,
        ),
      );
      resolveCode(code);
    } catch (err) {
      rejectCode(err instanceof Error ? err : new Error(String(err)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new YtAuthError(
            "CALLBACK_PORT_IN_USE",
            `Port ${binding.port} is already in use (required by web OAuth client "${client.alias}" -> ${client.redirectUri}). ` +
              `Stop the process holding port ${binding.port} briefly, or use a Desktop ("installed") OAuth client which binds an ephemeral port automatically.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(binding.port, binding.host, () => resolve());
  });

  const boundPort = (server.address() as AddressInfo).port;
  const redirectUri = binding.buildRedirectUri(boundPort);

  const oauth2Client = new google.auth.OAuth2(client.clientId, client.clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: options.scopes,
    state,
  });

  options.onAuthUrl?.({ url: authUrl, redirectUri });

  const timer = setTimeout(() => {
    rejectCode(
      new YtAuthError(
        "OAUTH_TIMEOUT",
        `Timed out waiting ${Math.round(timeoutMs / 1000)}s for OAuth callback on ${redirectUri}.`,
      ),
    );
  }, timeoutMs);

  let code: string;
  try {
    code = await codePromise;
  } finally {
    clearTimeout(timer);
    server.close();
  }

  const { tokens } = await oauth2Client.getToken(code);
  const existing = (() => {
    try {
      return store.getAccount(options.alias);
    } catch {
      return undefined;
    }
  })();

  const refreshToken = tokens.refresh_token ?? existing?.refreshToken;
  if (!refreshToken) {
    throw new YtAuthError(
      "MISSING_REFRESH_TOKEN",
      "Google did not return a refresh_token. Revoke previous access in Google Account > Third-party apps or retry with prompt=consent.",
    );
  }

  oauth2Client.setCredentials({ ...tokens, refresh_token: refreshToken });

  let channelId: string | undefined;
  let channelTitle: string | undefined;
  let handle: string | undefined;
  let accountEmail: string | undefined;
  let verified = false;

  if (options.provider === "youtube") {
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const resp = await youtube.channels.list({
      part: ["snippet"],
      mine: true,
    });
    const item = resp.data.items?.[0];
    if (!item?.id) {
      throw new YtAuthError(
        "NO_YOUTUBE_CHANNEL",
        "No YouTube channel found on the authorized Google account / Brand Channel.",
      );
    }
    channelId = item.id;
    channelTitle = item.snippet?.title ?? undefined;
    handle = item.snippet?.customUrl ?? undefined;
    verified = true;

    if (
      options.expectedChannelId &&
      isRealYouTubeChannelId(options.expectedChannelId) &&
      channelId !== options.expectedChannelId
    ) {
      throw new VaultGuardError(
        "EXPECTED_CHANNEL_MISMATCH",
        `Authorized channel "${channelTitle ?? channelId}" (${channelId}) does NOT match --expected-channel ${options.expectedChannelId}. Aborted without saving.`,
      );
    }
  } else if (options.provider === "google-drive") {
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const about = await drive.about.get({ fields: "user(emailAddress,displayName)" });
    accountEmail = about.data.user?.emailAddress ?? undefined;
    channelTitle = about.data.user?.displayName ?? undefined;
    verified = true;
  }

  const grantedScopes =
    typeof tokens.scope === "string" && tokens.scope.trim().length > 0
      ? tokens.scope.trim().split(/\s+/)
      : options.scopes;

  const saved = store.upsertAccount(
    {
      alias: options.alias,
      provider: options.provider,
      clientAlias: options.clientAlias,
      channelId,
      channelTitle,
      handle,
      accountEmail,
      googleProfile: options.googleProfile ?? accountEmail,
      workspace: options.workspace,
      permission: options.permission,
      scopes: grantedScopes,
      refreshToken,
      notes: options.notes,
      lastVerifiedAt: verified ? new Date().toISOString() : undefined,
    },
    { allowDuplicateChannel: options.allowDuplicateChannel },
  );

  return {
    account: saved,
    redirectUri,
    refreshedChannelVerification: verified,
  };
}
