/** Curated public metadata only. This validates a manifest, not an artifact's signature. */
export const clientPlatforms = ["android", "ios", "macos", "windows"] as const;
export type ClientPlatform = typeof clientPlatforms[number];
export type ClientRelease = {
  platform: ClientPlatform;
  arch: "arm64" | "x64" | "universal";
  channel: "stable" | "beta";
  version: string;
  build: number;
  status: "draft" | "published" | "withdrawn";
  distribution: "direct" | "app-store" | "testflight";
  url: string;
  sha256?: string;
  sizeBytes?: number;
  minOs: string;
  publishedAt: string;
  /** Release notes shown to users (plain text). */
  notes?: string;
};

export const clientArchitectures = ["arm64", "x64", "universal"] as const;
export type ClientArch = typeof clientArchitectures[number];
export type ClientChannel = ClientRelease["channel"];
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

/** Validates one release and projects only public fields. Used for the database and the legacy env manifest. */
export function validateClientRelease(item: unknown): ClientRelease {
  if (!item || typeof item !== "object") throw new Error("Invalid release item");
  const v = item as Record<string, unknown>;
  const member = (field: string, values: readonly string[]) => typeof v[field] === "string" && values.includes(v[field] as string);
  if (!member("platform", clientPlatforms) || !member("arch", clientArchitectures) || !member("channel", ["stable", "beta"])
    || !member("status", ["draft", "published", "withdrawn"]) || !member("distribution", ["direct", "app-store", "testflight"])) throw new Error("Invalid release target");
  if (typeof v.version !== "string" || !versionPattern.test(v.version) || v.version.length > 64
    || !Number.isSafeInteger(v.build) || Number(v.build) < 1 || Number(v.build) > 2_100_000_000) throw new Error("Invalid release version");
  if (v.channel === "stable" && v.version.includes("-")) throw new Error("Prerelease cannot be stable");
  if (typeof v.minOs !== "string" || !v.minOs.trim() || v.minOs.length > 80 || typeof v.publishedAt !== "string" || !Number.isFinite(Date.parse(v.publishedAt))) throw new Error("Invalid release requirements");
  if (typeof v.url !== "string" || v.url.length > 2048) throw new Error("Invalid download URL");
  const url = new URL(v.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Downloads require HTTPS without credentials or fragments");
  if (v.distribution === "direct") {
    if (v.platform === "ios" || typeof v.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(v.sha256) || !Number.isSafeInteger(v.sizeBytes) || Number(v.sizeBytes) <= 0) throw new Error("Direct downloads require digest and size; iOS uses approved distribution links");
  } else {
    if (v.platform !== "ios" && v.platform !== "macos") throw new Error("Apple distribution requires an Apple platform");
    const host = v.distribution === "app-store" ? "apps.apple.com" : "testflight.apple.com";
    if (url.hostname !== host || url.port) throw new Error("Invalid Apple distribution URL");
    if (v.distribution === "testflight" && v.channel !== "beta") throw new Error("TestFlight is beta only");
  }
  if (v.platform === "ios" && v.arch !== "universal") throw new Error("iPhone and iPad share a universal release");
  // Explicit projection: do not expose signing secrets or extra operator fields.
  return {
    platform: v.platform, arch: v.arch, channel: v.channel, version: v.version, build: v.build,
    status: v.status, distribution: v.distribution, url: url.href, minOs: v.minOs, publishedAt: v.publishedAt,
    ...(v.distribution === "direct" ? { sha256: (v.sha256 as string).toLowerCase(), sizeBytes: v.sizeBytes } : {}),
    ...(typeof v.notes === "string" && v.notes.trim() ? { notes: v.notes.trim().slice(0, 4000) } : {}),
  } as ClientRelease;
}

/** Legacy read-only manifest from NORTHSTAR_CLIENT_RELEASES_JSON. New releases live in the database. */
export function parseClientReleases(raw: string): ClientRelease[] {
  if (raw.length > 131072) throw new Error("Client release manifest too large");
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length > 200) throw new Error("Invalid release list");
  const seen = new Set<string>();
  return data.map((item: unknown) => {
    const release = validateClientRelease(item);
    const key = `${release.platform}:${release.arch}:${release.channel}:${release.build}`;
    if (seen.has(key)) throw new Error("Duplicate release build");
    seen.add(key);
    return release;
  });
}

/** Beta testers also receive a newer stable build; stable users never see beta builds. */
export function latestClientReleases(releases: ClientRelease[], channel: ClientChannel = "stable", now = Date.now()): ClientRelease[] {
  const latest = new Map<string, ClientRelease>();
  for (const item of releases) {
    if ((item.channel !== channel && channel !== "beta") || item.status !== "published" || Date.parse(item.publishedAt) > now) continue;
    const key = `${item.platform}:${item.arch}`;
    if (!latest.has(key) || latest.get(key)!.build < item.build) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.arch.localeCompare(b.arch));
}

/**
 * Older published builds per platform (newest first), excluding the current ones from latestClientReleases.
 * Withdrawn builds never appear; stable users see stable history only.
 */
export function clientReleaseHistory(releases: ClientRelease[], channel: ClientChannel = "stable", perPlatform = 10, now = Date.now()): ClientRelease[] {
  const current = new Set(latestClientReleases(releases, channel, now).map((item) => `${item.platform}:${item.arch}:${item.build}`));
  const seen = new Set<string>(), counts = new Map<string, number>();
  return releases
    .filter((item) => (item.channel === channel || channel === "beta") && item.status === "published" && Date.parse(item.publishedAt) <= now)
    .sort((a, b) => a.platform.localeCompare(b.platform) || b.build - a.build || a.arch.localeCompare(b.arch))
    .filter((item) => {
      const key = `${item.platform}:${item.arch}:${item.build}`;
      if (current.has(key) || seen.has(key)) return false;
      seen.add(key);
      const count = counts.get(item.platform) || 0;
      counts.set(item.platform, count + 1);
      return count < perPlatform;
    });
}

/** Release for one installation: the exact architecture wins, otherwise a universal package. */
export function releaseFor(releases: ClientRelease[], platform: ClientPlatform, arch: ClientArch | undefined, channel: ClientChannel = "stable", now = Date.now()): ClientRelease | null {
  const candidates = latestClientReleases(releases, channel, now).filter((item) => item.platform === platform);
  return candidates.find((item) => item.arch === arch) || candidates.find((item) => item.arch === "universal")
    || (arch ? null : candidates.find((item) => item.arch === defaultArch[platform]) || candidates[0] || null);
}
const defaultArch: Record<ClientPlatform, ClientArch> = { android: "universal", ios: "universal", macos: "universal", windows: "x64" };

/** `X-Northstar-Client: android/1.2.3+45`. Clients send it on every request so the server can require upgrades. */
export type ClientAgent = { platform: ClientPlatform; version: string; build: number };
export function parseClientAgent(header: string | null | undefined): ClientAgent | null {
  const match = header?.trim().match(/^(android|ios|macos|windows)\/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\+(\d{1,10})$/);
  if (!match || match[2].length > 64) return null;
  const build = Number(match[3]);
  return Number.isSafeInteger(build) && build >= 1 ? { platform: match[1] as ClientPlatform, version: match[2], build } : null;
}

export type UpdateDecision = { latest: ClientRelease | null; updateAvailable: boolean; mandatory: boolean; minBuild: number };
/** A missing build number is treated as older than any minimum, so pre-header clients are blocked once a minimum is set. */
export function updateDecision(latest: ClientRelease | null, minBuild: number, build: number | null): UpdateDecision {
  const current = build ?? 0;
  return { latest, updateAvailable: !!latest && latest.build > current, mandatory: minBuild > 0 && current < minBuild, minBuild };
}
