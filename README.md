# `@schalkez/yt-auth`

Centralized, **agent-first** YouTube Data API v3, YouTube Analytics API v2, and Google Drive OAuth vault — designed to consolidate scattered Google profiles, Brand Channels, and GCP projects across TypeScript, Go, and MCP-powered AI agents.

## Why

- **One encrypted central vault (`~/.yt-auth/vault.enc.json`)**: AES-256-GCM encrypted at rest (key in `~/.yt-auth/master.key` or `YT_AUTH_MASTER_KEY`). Never scatter `refresh_token` across 5 different `.env` files or risk committing secrets.
- **Permanent headless operation**: Authorize each Brand Channel **once** via loopback (`access_type=offline`, `prompt=consent`) on an **In production** Google Cloud OAuth client — every subsequent call auto-refreshes `access_token` indefinitely.
- **Multi-client (multi-GCP project)**: Keep separate OAuth clients (`gafv`, `krillinai`, `studio`, ...) in one vault so daily 10,000-unit YouTube quotas stay isolated. Supports both `installed` (Desktop, ephemeral loopback port) and `web` (fixed callback URL) clients.
- **Cross-channel & cross-profile safety guards**:
  - Enforces unique real `UC...` `channelId` per alias (blocks accidentally binding the same Brand Channel twice).
  - SDK/CLI guards: `expectedChannelId`, `expectedWorkspace`, `requireWrite`, and `permission: "readonly" | "write"`.
- **Works across TS, Go, Shell, and AI Agents**:
  - **Node/TS SDK**: `import { getYouTubeClient } from "@schalkez/yt-auth"`
  - **CLI (JSON-first)**: `yt-auth token <alias> --json`, `yt-auth yt videos <alias>`, `yt-auth yt analytics <alias>`
  - **Read-only MCP Server**: `yt-auth mcp` (safe global agent toolset for Antigravity / Claude Code / Cursor).
- **Zero-reauth importers**: Built-in read-only importers for `gafv` (`gavf.db`) and `krillinAI` (`krillinai.db` + `youtube_token_ch_*.json`).

---

## Install & Global CLI

```bash
pnpm install
pnpm run build
pnpm link --global
```

In any sibling Node/TS repo (e.g. `ai-video-studio` or `gafv`):

```json
{
  "dependencies": {
    "@schalkez/yt-auth": "file:../yt-auth"
  }
}
```

Or install from **GitHub Packages (`https://npm.pkg.github.com`)**:

1. Add to `~/.npmrc` (or project `.npmrc`):
   ```ini
   @schalkez:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
   ```
   *(Or login once via `gh auth refresh -s read:packages` and export `GITHUB_PACKAGES_TOKEN=$(gh auth token)`.)*
2. Install in any repo:
   ```bash
   pnpm add @schalkez/yt-auth
   ```

Or install directly from private GitHub via git URL:

```bash
pnpm add github:Schalkez/yt-auth
```

### Publishing a New Release

Push a semver tag matching `package.json` version (GitHub Actions runs `pnpm run check` and publishes automatically via `GITHUB_TOKEN`):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

---

## Quickstart

### 1. Import existing channels from `gafv` and `krillinAI` (read-only, no re-login)

```bash
yt-auth import gafv --dir "../gafv" --dry-run
yt-auth import gafv --dir "../gafv"

yt-auth import krillin --dir "../krillinAI" --dry-run
yt-auth import krillin --dir "../krillinAI"
```

### 2. Verify all tokens & resolve real `UC...` channel IDs

```bash
yt-auth doctor --resolve
```

### 3. Add a new Brand Channel

```bash
# Option A: Import a Desktop OAuth client_secrets.json (recommended: auto ephemeral port)
yt-auth client import-json studio ./client_secrets.json

# Authorize once — open the printed URL in the exact Chrome profile for this channel
yt-auth login main-channel \
  --client studio \
  --preset analytics \
  --workspace my-studio \
  --profile studio@example.com \
  --expected-channel UC0000000000000000000001
```

> **Important (Infinite Refresh Token):** In Google Cloud Console → **Google Auth Platform → Audience**, click **Publish App** (`Testing` → `In production`) **before** running `yt-auth login`. Tokens issued in `Testing` mode expire after 7 days; tokens issued in `In production` do not expire (unless unused for 6 months or revoked).

---

## TypeScript SDK Usage

```ts
import { getYouTubeClient, fetchRecentVideos, fetchAnalyticsReport } from "@schalkez/yt-auth";

const { youtube, analytics, account } = await getYouTubeClient("main-channel", {
  expectedWorkspace: "my-studio",
  expectedChannelId: "UC0000000000000000000001",
  requireWrite: false,
});

const videos = await fetchRecentVideos("main-channel", 10, {
  expectedWorkspace: "my-studio",
});
const report = await fetchAnalyticsReport("main-channel", { days: 28, dimension: "video" });
```

## Go Integration (`gafv/apps/worker-go` or `krillinAI`)

Reuse the exact same central vault from Go via a tiny `oauth2.TokenSource` backed by `yt-auth token`:

```go
type YtAuthTokenSource struct {
	Alias             string
	ExpectedChannelID string
	Workspace         string
}

func (s YtAuthTokenSource) Token() (*oauth2.Token, error) {
	args := []string{"token", s.Alias, "--json"}
	if s.ExpectedChannelID != "" {
		args = append(args, "--expected-channel", s.ExpectedChannelID)
	}
	if s.Workspace != "" {
		args = append(args, "--workspace", s.Workspace)
	}
	out, err := exec.Command("yt-auth", args...).Output()
	if err != nil {
		return nil, err
	}
	var resp struct {
		AccessToken string `json:"accessToken"`
		ExpiryDate  int64  `json:"expiryDate"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, err
	}
	return &oauth2.Token{
		AccessToken: resp.AccessToken,
		TokenType:   "Bearer",
		Expiry:      time.UnixMilli(resp.ExpiryDate),
	}, nil
}
```

## MCP Server Configuration (Agent-First)

Add to your MCP config (Antigravity / Claude Code / Cursor):

```json
{
  "mcpServers": {
    "yt-auth": {
      "command": "yt-auth",
      "args": ["mcp"]
    }
  }
}
```

Exposed read-only tools (zero tokens ever returned):
- `yt_list_accounts`
- `yt_doctor`
- `yt_channel_stats`
- `yt_list_videos`
- `yt_analytics_report`
