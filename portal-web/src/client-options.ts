/** Third-party apps the Portal imports the account's subscription into; links point at their official download pages. */
export type AppId = "clash" | "hiddify" | "shadowrocket" | "v2rayng";
export const apps: Record<AppId, { name: string; letter: string; platforms: string; url: string }> = {
  clash: { name: "Clash Verge", letter: "C", platforms: "Mac · Windows · Linux", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases" },
  hiddify: { name: "Hiddify", letter: "H", platforms: "iPhone · Android · Mac · Windows", url: "https://github.com/hiddify/hiddify-app/releases" },
  shadowrocket: { name: "Shadowrocket", letter: "S", platforms: "iPhone · iPad", url: "https://apps.apple.com/app/id932747118" },
  v2rayng: { name: "v2rayNG", letter: "V", platforms: "Android", url: "https://github.com/2dust/v2rayNG/releases" },
};
/** The apps in the order this device's visitor most likely uses them. */
export function appsFor(platform: string): AppId[] {
  if (platform === "ios") return ["shadowrocket", "hiddify", "clash", "v2rayng"];
  if (platform === "android") return ["hiddify", "v2rayng", "clash", "shadowrocket"];
  return ["clash", "hiddify", "shadowrocket", "v2rayng"];
}
/** Apps that run on this device, so the first of them can be marked as this device's. */
export const runsOn = (id: AppId, platform: string) => id === "hiddify" || (id === "shadowrocket" ? platform === "ios" : id === "v2rayng" ? platform === "android" : platform !== "ios" && platform !== "android");

export function usableCredential(item: { status: string; userDisabled: boolean; adminDisabled: boolean; accountStatus: string; expiresAt?: string | null }, now = Date.now()) {
  return item.status === "active" && !item.userDisabled && !item.adminDisabled && item.accountStatus === "active"
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}
