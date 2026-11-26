import type { Permission, Provider } from "./types.js";

export const YOUTUBE_SCOPES = {
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  analyticsReadonly: "https://www.googleapis.com/auth/yt-analytics.readonly",
  analyticsMonetaryReadonly: "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  manage: "https://www.googleapis.com/auth/youtube",
  upload: "https://www.googleapis.com/auth/youtube.upload",
  forceSsl: "https://www.googleapis.com/auth/youtube.force-ssl",
  partner: "https://www.googleapis.com/auth/youtubepartner",
} as const;

export const DRIVE_SCOPES = {
  readonly: "https://www.googleapis.com/auth/drive.readonly",
  file: "https://www.googleapis.com/auth/drive.file",
  full: "https://www.googleapis.com/auth/drive",
} as const;

export const SCOPE_PRESETS = {
  readonly: [YOUTUBE_SCOPES.readonly],
  analytics: [
    YOUTUBE_SCOPES.readonly,
    YOUTUBE_SCOPES.analyticsReadonly,
    YOUTUBE_SCOPES.analyticsMonetaryReadonly,
  ],
  studio: [
    YOUTUBE_SCOPES.readonly,
    YOUTUBE_SCOPES.analyticsReadonly,
    YOUTUBE_SCOPES.analyticsMonetaryReadonly,
    YOUTUBE_SCOPES.upload,
    YOUTUBE_SCOPES.manage,
  ],
  full: [
    YOUTUBE_SCOPES.manage,
    YOUTUBE_SCOPES.upload,
    YOUTUBE_SCOPES.readonly,
    YOUTUBE_SCOPES.forceSsl,
    YOUTUBE_SCOPES.analyticsReadonly,
    YOUTUBE_SCOPES.analyticsMonetaryReadonly,
    YOUTUBE_SCOPES.partner,
  ],
  "drive-readonly": [DRIVE_SCOPES.readonly],
  "drive-file": [DRIVE_SCOPES.file],
  drive: [DRIVE_SCOPES.full],
} as const;

export type ScopePresetName = keyof typeof SCOPE_PRESETS;

const YOUTUBE_WRITE_SCOPES = new Set<string>([
  YOUTUBE_SCOPES.manage,
  YOUTUBE_SCOPES.upload,
  YOUTUBE_SCOPES.forceSsl,
]);

const DRIVE_WRITE_SCOPES = new Set<string>([DRIVE_SCOPES.file, DRIVE_SCOPES.full]);

export function resolveScopes(presetOrList: string): string[] {
  const trimmed = presetOrList.trim();
  if (trimmed in SCOPE_PRESETS) {
    return [...SCOPE_PRESETS[trimmed as ScopePresetName]];
  }
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      `Invalid scope preset or list "${presetOrList}". Valid presets: ${Object.keys(SCOPE_PRESETS).join(", ")}`,
    );
  }
  const expanded: string[] = [];
  for (const part of parts) {
    if (part in SCOPE_PRESETS) {
      expanded.push(...SCOPE_PRESETS[part as ScopePresetName]);
    } else if (part.startsWith("https://")) {
      expanded.push(part);
    } else {
      throw new Error(
        `Unknown scope or preset "${part}". Use a preset (${Object.keys(SCOPE_PRESETS).join(", ")}) or full https:// scope URL.`,
      );
    }
  }
  return Array.from(new Set(expanded));
}

export function hasWriteScope(provider: Provider, scopes: string[]): boolean {
  if (scopes.length === 0) {
    // Imported legacy tokens may not have recorded exact granted scope list.
    return true;
  }
  const writeSet = provider === "youtube" ? YOUTUBE_WRITE_SCOPES : DRIVE_WRITE_SCOPES;
  return scopes.some((s) => writeSet.has(s));
}

export function defaultPermissionForPreset(preset: string): Permission {
  if (preset === "readonly" || preset === "analytics" || preset === "drive-readonly") {
    return "readonly";
  }
  return "write";
}
