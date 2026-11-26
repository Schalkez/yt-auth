import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { VaultGuardError, YtAuthError, isRealYouTubeChannelId, slugifyAlias } from "../src/types.js";
import { VaultStore } from "../src/vault.js";

const tempDirs: string[] = [];

function makeTempVaultDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-auth-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("VaultStore", () => {
  it("encrypts vault data at rest and never stores plaintext refreshToken or clientSecret", () => {
    const dir = makeTempVaultDir();
    const store = new VaultStore(dir);

    store.upsertClient({
      alias: "studio",
      type: "installed",
      projectId: "studio-proj",
      clientId: "123456789012-abc.apps.googleusercontent.com",
      clientSecret: "SUPER_SECRET_CLIENT_VALUE",
      redirectUri: "http://localhost",
    });

    store.upsertAccount({
      alias: "science-channel",
      provider: "youtube",
      clientAlias: "studio",
      channelId: "UC0000000000000000000001",
      channelTitle: "Science Lab",
      handle: "@ScienceLabExample",
      googleProfile: "studio@example.com",
      workspace: "video-studio",
      permission: "readonly",
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      refreshToken: "1//SUPER_SECRET_REFRESH_TOKEN",
    });

    const rawDisk = fs.readFileSync(store.filePath, "utf8");
    expect(rawDisk).not.toContain("SUPER_SECRET_CLIENT_VALUE");
    expect(rawDisk).not.toContain("SUPER_SECRET_REFRESH_TOKEN");

    const loaded = store.getAccount("science-channel");
    expect(loaded.refreshToken).toBe("1//SUPER_SECRET_REFRESH_TOKEN");
    expect(loaded.channelId).toBe("UC0000000000000000000001");

    const publicAccounts = store.listAccounts({ workspace: "video-studio" });
    expect(publicAccounts).toHaveLength(1);
    expect("refreshToken" in (publicAccounts[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("blocks binding the same real YouTube UC channelId to two different aliases", () => {
    const dir = makeTempVaultDir();
    const store = new VaultStore(dir);

    store.upsertClient({
      alias: "factory",
      type: "web",
      clientId: "client-id-1",
      clientSecret: "client-sec-1",
      redirectUri: "http://localhost:3000/api/auth/youtube/callback",
    });

    store.upsertAccount({
      alias: "factory-ja-vi",
      provider: "youtube",
      clientAlias: "factory",
      channelId: "UC0000000000000000000002",
      channelTitle: "Sample Channel A",
      workspace: "factory",
      permission: "write",
      scopes: [],
      refreshToken: "rt-1",
    });

    expect(() =>
      store.upsertAccount({
        alias: "accidental-duplicate",
        provider: "youtube",
        clientAlias: "factory",
        channelId: "UC0000000000000000000002",
        channelTitle: "Wrong Brand Selection",
        workspace: "video-studio",
        permission: "readonly",
        scopes: [],
        refreshToken: "rt-2",
      }),
    ).toThrow(VaultGuardError);
  });

  it("prevents removing an OAuth client while accounts still reference it unless forced", () => {
    const dir = makeTempVaultDir();
    const store = new VaultStore(dir);

    store.upsertClient({
      alias: "studio",
      type: "installed",
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "http://localhost",
    });
    store.upsertAccount({
      alias: "ch-1",
      provider: "youtube",
      clientAlias: "studio",
      permission: "readonly",
      scopes: [],
      refreshToken: "rt-ch1",
    });

    expect(() => store.removeClient("studio")).toThrow(VaultGuardError);
    store.removeClient("studio", true);
    expect(() => store.getClient("studio")).toThrow(YtAuthError);
  });

  it("validates real YouTube UC channel IDs and slugifies Vietnamese names cleanly", () => {
    expect(isRealYouTubeChannelId("UC0000000000000000000001")).toBe(true);
    expect(isRealYouTubeChannelId("UC-A_b1234567890abcdef12")).toBe(true);
    expect(isRealYouTubeChannelId("test_page_id")).toBe(false);
    expect(isRealYouTubeChannelId("UC_short")).toBe(false);
    expect(slugifyAlias("Thế Giới Động Vật Hoang Dã")).toBe("the-gioi-dong-vat-hoang-da");
  });
});
