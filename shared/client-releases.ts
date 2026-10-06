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
};

export function parseClientReleases(raw: string): ClientRelease[] {
  if (raw.length > 131072) throw new Error("Client release manifest too large");
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length > 200) throw new Error("Invalid release list");
  const seen = new Set<string>();
  return data.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid release item");
    const v = item as Record<string, unknown>;
    const member = (field: string, values: readonly string[]) => typeof v[field] === "string" && values.includes(v[field] as string);
    if (!member("platform", clientPlatforms) || !member("arch", ["arm64", "x64", "universal"]) || !member("channel", ["stable", "beta"])
      || !member("status", ["draft", "published", "withdrawn"]) || !member("distribution", ["direct", "app-store", "testflight"])) throw new Error("Invalid release target");
    if (typeof v.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v.version) || v.version.length > 64
      || !Number.isSafeInteger(v.build) || Number(v.build) < 1) throw new Error("Invalid release version");
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
    const key = `${v.platform}:${v.arch}:${v.channel}:${v.build}`;
    if (seen.has(key)) throw new Error("Duplicate release build");
    seen.add(key);
    // Explicit projection: do not expose signing secrets or extra operator fields.
    return {
      platform: v.platform, arch: v.arch, channel: v.channel, version: v.version, build: v.build,
      status: v.status, distribution: v.distribution, url: url.href, minOs: v.minOs, publishedAt: v.publishedAt,
      ...(v.distribution === "direct" ? { sha256: (v.sha256 as string).toLowerCase(), sizeBytes: v.sizeBytes } : {}),
    } as ClientRelease;
  });
}

export function latestClientReleases(releases: ClientRelease[], channel: "stable" | "beta" = "stable", now = Date.now()): ClientRelease[] {
  const latest = new Map<string, ClientRelease>();
  for (const item of releases) {
    if (item.channel !== channel || item.status !== "published" || Date.parse(item.publishedAt) > now) continue;
    const key = `${item.platform}:${item.arch}`;
    if (!latest.has(key) || latest.get(key)!.build < item.build) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.arch.localeCompare(b.arch));
}
