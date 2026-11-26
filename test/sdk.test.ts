import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SCOPE_PRESETS, resolveScopes } from "../src/scopes.js";
import { getDriveClient, getYouTubeClient } from "../src/sdk.js";
import { VaultGuardError } from "../src/types.js";
import { VaultStore } from "../src/vault.js";

const tempDirs: string[] = [];

function setupVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-auth-sdk-"));
  tempDirs.push(dir);
  const store = new VaultStore(dir);

  store.upsertClient({
    alias: "studio",
    type: "installed",
    clientId: "cid-studio",
    clientSecret: "csec-studio",
    redirectUri: "http://localhost",
  });

  store.upsertAccount({
    alias: "science-channel",
    provider: "youtube",
    clientAlias: "studio",
    channelId: "UC0000000000000000000001",
    channelTitle: "Science Lab",
    workspace: "video-studio",
    permission: "readonly",
    scopes: [...SCOPE_PRESETS.analytics],
    refreshToken: "rt-ch1",
  });

  store.upsertAccount({
    alias: "factory-ja-vi",
    provider: "youtube",
    clientAlias: "studio",
    channelId: "UC0000000000000000000002",
    channelTitle: "Factory JA",
    workspace: "factory",
    permission: "write",
    scopes: [...SCOPE_PRESETS.full],
    refreshToken: "rt-ja",
  });

  store.upsertAccount({
    alias: "factory-drive",
    provider: "google-drive",
    clientAlias: "studio",
    workspace: "factory",
    permission: "write",
    scopes: [...SCOPE_PRESETS.drive],
    refreshToken: "rt-drive",
  });

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SDK Guardrails", () => {
  it("allows matching workspace and channelId for read-only YouTube client", async () => {
    const vaultDir = setupVault();
    const bundle = await getYouTubeClient("science-channel", {
      vaultDir,
      expectedWorkspace: "video-studio",
      expectedChannelId: "UC0000000000000000000001",
      requireWrite: false,
    });
    expect(bundle.account.alias).toBe("science-channel");
    expect(bundle.youtube).toBeDefined();
    expect(bundle.analytics).toBeDefined();
  });

  it("rejects cross-workspace access", async () => {
    const vaultDir = setupVault();
    await expect(
      getYouTubeClient("factory-ja-vi", {
        vaultDir,
        expectedWorkspace: "video-studio",
      }),
    ).rejects.toThrow(VaultGuardError);
  });

  it("rejects expectedChannelId mismatch", async () => {
    const vaultDir = setupVault();
    await expect(
      getYouTubeClient("science-channel", {
        vaultDir,
        expectedChannelId: "UC0000000000000000000002",
      }),
    ).rejects.toThrow(VaultGuardError);
  });

  it("rejects requireWrite on a readonly account", async () => {
    const vaultDir = setupVault();
    await expect(
      getYouTubeClient("science-channel", {
        vaultDir,
        requireWrite: true,
      }),
    ).rejects.toThrow(VaultGuardError);
  });

  it("allows requireWrite on a write-enabled account with write scopes", async () => {
    const vaultDir = setupVault();
    const bundle = await getYouTubeClient("factory-ja-vi", {
      vaultDir,
      expectedWorkspace: "factory",
      requireWrite: true,
    });
    expect(bundle.account.permission).toBe("write");
  });

  it("rejects wrong provider between youtube and google-drive helpers", async () => {
    const vaultDir = setupVault();
    await expect(getYouTubeClient("factory-drive", { vaultDir })).rejects.toThrow(VaultGuardError);
    expect(() => getDriveClient("science-channel", { vaultDir })).toThrow(VaultGuardError);
    expect(getDriveClient("factory-drive", { vaultDir }).drive).toBeDefined();
  });

  it("expands scope presets and rejects invalid scope names", () => {
    expect(resolveScopes("analytics")).toContain(
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    );
    expect(resolveScopes("readonly,https://www.googleapis.com/auth/youtube.upload")).toHaveLength(2);
    expect(() => resolveScopes("not-a-real-preset")).toThrow();
  });
});
