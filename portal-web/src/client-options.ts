/** How an app takes the subscription: its own deep link, or the copied link pasted in the app. */
export type ImportKind = "clash" | "stash" | "shadowrocket" | "copy";
/**
 * Third-party apps the Portal imports the account's subscription into, the same list on every device, in display
 * order (computers, Android, iPhone). Links point at their official download pages.
 */
export type AppId = "clashverge" | "clashx" | "v2rayn" | "clashmeta" | "v2rayng" | "shadowrocket" | "stash";
export const apps: Record<AppId, { name: string; code: string; platforms: string; import: ImportKind; url: string }> = {
  clashverge: { name: "Clash Verge Rev", code: "CV", platforms: "Mac · Windows · Linux", import: "clash", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
  clashx: { name: "ClashX Meta", code: "CX", platforms: "Mac", import: "clash", url: "https://github.com/MetaCubeX/ClashX.Meta/releases" },
  v2rayn: { name: "v2rayN", code: "VN", platforms: "Windows", import: "copy", url: "https://github.com/2dust/v2rayN/releases" },
  clashmeta: { name: "Clash Meta for Android", code: "CM", platforms: "Android", import: "clash", url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases" },
  v2rayng: { name: "v2rayNG", code: "NG", platforms: "Android", import: "copy", url: "https://github.com/2dust/v2rayNG/releases" },
  shadowrocket: { name: "Shadowrocket", code: "SR", platforms: "iPhone · iPad", import: "shadowrocket", url: "https://apps.apple.com/app/id932747118" },
  stash: { name: "Stash", code: "ST", platforms: "iPhone · iPad · Mac", import: "stash", url: "https://apps.apple.com/app/id1596063349" },
};
export const appOrder = Object.keys(apps) as AppId[];

export function usableCredential(item: { status: string; userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null }, now = Date.now()) {
  return item.status === "active" && !item.userDisabled && !item.adminDisabled && item.accountStatus === "active"
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}
