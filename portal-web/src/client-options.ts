import type { Platform } from "./format";

/** How an app takes the subscription: its own deep link, or the copied link pasted in the app. */
export type ImportKind = "clash" | "stash" | "shadowrocket" | "copy";
/** Third-party apps the Portal imports the account's subscription into; links point at their official download pages. */
export type AppId = "shadowrocket" | "stash" | "clashmeta" | "v2rayng" | "clashverge" | "clashx" | "v2rayn";
export const apps: Record<AppId, { name: string; code: string; import: ImportKind; url: string }> = {
  shadowrocket: { name: "Shadowrocket", code: "SR", import: "shadowrocket", url: "https://apps.apple.com/app/id932747118" },
  stash: { name: "Stash", code: "ST", import: "stash", url: "https://apps.apple.com/app/id1596063349" },
  clashmeta: { name: "Clash Meta for Android", code: "CM", import: "clash", url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases" },
  v2rayng: { name: "v2rayNG", code: "NG", import: "copy", url: "https://github.com/2dust/v2rayNG/releases" },
  clashverge: { name: "Clash Verge Rev", code: "CV", import: "clash", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
  clashx: { name: "ClashX Meta", code: "CX", import: "clash", url: "https://github.com/MetaCubeX/ClashX.Meta/releases" },
  v2rayn: { name: "v2rayN", code: "VN", import: "copy", url: "https://github.com/2dust/v2rayN/releases" },
};

/** The platforms in the order the Portal lists them, each with its apps (most used first). */
export const platformApps: Record<Platform, AppId[]> = {
  ios: ["shadowrocket", "stash"],
  android: ["clashmeta", "v2rayng"],
  mac: ["clashverge", "clashx"],
  windows: ["clashverge", "v2rayn"],
  linux: ["clashverge"],
};
export const platforms = Object.keys(platformApps) as Platform[];

/** The apps that run on this device; the import tiles show only these. */
export const appsFor = (platform: Platform): AppId[] => platformApps[platform];
/** The other platforms with their apps, for the "other devices" list. */
export const otherPlatforms = (platform: Platform) => platforms.filter((item) => item !== platform).map((item) => ({ platform: item, apps: platformApps[item] }));

export function usableCredential(item: { status: string; userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null }, now = Date.now()) {
  return item.status === "active" && !item.userDisabled && !item.adminDisabled && item.accountStatus === "active"
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}
