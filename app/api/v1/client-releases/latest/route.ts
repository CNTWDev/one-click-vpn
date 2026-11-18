import { NextResponse } from "next/server";
import { clientArchitectures, clientPlatforms, type ClientArch, type ClientPlatform } from "../../../../../shared/client-releases";
import { downloadPath, updateCheck, validInstallation } from "../../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LAST_SANDBOXED_MAC_BUILD = 37;

/** Update check for installed clients: GET ?platform=android&arch=universal&build=12&channel=stable&installation=<random id> */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams, headers = { "Cache-Control": "no-store" };
  const platform = query.get("platform") as ClientPlatform, arch = (query.get("arch") || undefined) as ClientArch | undefined;
  const channel = query.get("channel") || "stable", rawBuild = query.get("build");
  const build = rawBuild && /^\d{1,10}$/.test(rawBuild) ? Number(rawBuild) : null, installation = query.get("installation");
  if ((installation && !validInstallation(installation)) || !clientPlatforms.includes(platform) || (arch && !clientArchitectures.includes(arch)) || (channel !== "stable" && channel !== "beta") || (rawBuild && build === null)) {
    return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400, headers });
  }
  try {
    const decision = await updateCheck({ platform, arch, channel, build, installation: installation || undefined });
    // Mac builds up to 37 (1.0.9) run in the App Sandbox: a DMG they download gets a hard quarantine flag and the
    // installed app then refuses to launch. Without a digest they open the download page in the browser instead.
    const latest = platform === "macos" && build !== null && build <= LAST_SANDBOXED_MAC_BUILD && decision.latest
      ? (({ sha256: _sha, sizeBytes: _size, ...rest }) => rest)(decision.latest as Record<string, unknown> & { sha256?: string; sizeBytes?: number })
      : decision.latest;
    return NextResponse.json({ ...decision, latest, downloadPath: downloadPath(platform, decision.latest?.arch) }, { headers });
  } catch {
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
