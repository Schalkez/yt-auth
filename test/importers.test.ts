import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { importFromGafv, importFromKrillin } from "../src/importers.js";
import { VaultStore } from "../src/vault.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Read-only Importers (GAFV & KrillinAI)", () => {
  it("imports active GAFV channels and Master Drive token while skipping paused networks by default", async () => {
    const gafvDir = makeTempDir("yt-auth-gafv-");
    const vaultDir = makeTempDir("yt-auth-vault-");

    fs.writeFileSync(
      path.join(gafvDir, ".env.local"),
      'YOUTUBE_CLIENT_ID="111111111111-test.apps.googleusercontent.com"\nYOUTUBE_CLIENT_SECRET="fake-gafv-secret"\n',
      "utf8",
    );
    fs.mkdirSync(path.join(gafvDir, "packages", "db"), { recursive: true });
    const dbPath = path.join(gafvDir, "packages", "db", "gavf.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE networks (id TEXT PRIMARY KEY, name TEXT, status TEXT);
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        network_id TEXT,
        platform TEXT,
        channel_name TEXT,
        channel_id TEXT,
        refresh_token TEXT,
        is_active INTEGER
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO networks VALUES ('net1', 'JA to VI Network', 'active');
      INSERT INTO networks VALUES ('net2', 'KO to VI Network', 'paused');
      INSERT INTO channels VALUES ('c1', 'net1', 'youtube', 'Sample JA Channel', 'UC0000000000000000000011', 'rt-ja-vi', 1);
      INSERT INTO channels VALUES ('c2', 'net1', 'youtube', 'Disconnected Channel', 'UC0000000000000000000012', NULL, 1);
      INSERT INTO channels VALUES ('c3', 'net2', 'youtube', 'Paused Channel', 'UC0000000000000000000013', 'rt-ko-vi', 1);
      INSERT INTO app_settings VALUES ('MASTER_DRIVE_REFRESH_TOKEN', 'rt-master-drive');
    `);
    // Ensure file > 4096 bytes so populated-DB check matches real gavf.db
    db.exec("CREATE TABLE pad (x TEXT); INSERT INTO pad VALUES ('" + "a".repeat(5000) + "');");
    db.close();

    const dry = await importFromGafv(gafvDir, { vaultDir, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.imported).toHaveLength(2);
    expect(dry.skipped).toHaveLength(2);
    expect(new VaultStore(vaultDir).listAccounts()).toHaveLength(0);

    const live = await importFromGafv(gafvDir, { vaultDir });
    expect(live.imported.map((i) => i.alias)).toEqual(["gafv-ja-vi", "gafv-master-drive"]);

    const withPaused = await importFromGafv(gafvDir, { vaultDir, activeOnly: false });
    expect(withPaused.imported.map((i) => i.alias)).toContain("gafv-ko-vi");

    const store = new VaultStore(vaultDir);
    expect(store.getAccount("gafv-ja-vi").channelId).toBe("UC0000000000000000000011");
    expect(store.getAccount("gafv-master-drive").provider).toBe("google-drive");
  });

  it("imports KrillinAI client_secrets.json and token files while stripping fake placeholder page_ids", async () => {
    const krillinDir = makeTempDir("yt-auth-krillin-");
    const vaultDir = makeTempDir("yt-auth-vault-");

    fs.mkdirSync(path.join(krillinDir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(krillinDir, "config", "client_secrets.json"),
      JSON.stringify({
        installed: {
          client_id: "222222222222-test.apps.googleusercontent.com",
          project_id: "demo-project",
          client_secret: "fake-krillin-secret",
          redirect_uris: ["http://localhost"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(krillinDir, "config", "youtube_token_ch_1.json"),
      JSON.stringify({
        access_token: "expired-at",
        refresh_token: "rt-krillin-1",
      }),
      "utf8",
    );

    const db = new DatabaseSync(path.join(krillinDir, "krillinai.db"));
    db.exec(`
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY,
        name TEXT,
        platform TEXT,
        page_id TEXT,
        access_token TEXT,
        enabled INTEGER
      );
      INSERT INTO channels VALUES (1, 'Sample Channel', 'youtube', 'UC_placeholder', 'config/youtube_token_ch_1.json', 1);
      INSERT INTO channels VALUES (2, 'Facebook Page', 'facebook', '999999999999999', 'fb-tok', 1);
    `);
    db.close();

    const summary = await importFromKrillin(krillinDir, { vaultDir });
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]?.alias).toBe("krillin-sample-channel");
    // Fake placeholder must be stripped so doctor --resolve fills the real 24-char UC ID
    expect(summary.imported[0]?.channelId).toBeUndefined();

    const store = new VaultStore(vaultDir);
    expect(store.getClient("krillinai").type).toBe("installed");
    expect(store.getAccount("krillin-sample-channel").refreshToken).toBe("rt-krillin-1");
  });
});
