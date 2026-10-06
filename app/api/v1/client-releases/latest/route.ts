import { NextResponse } from "next/server";
import { clientArchitectures, clientPlatforms, type ClientArch, type ClientPlatform } from "../../../../../shared/client-releases";
import { downloadPath, updateCheck } from "../../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Update check for installed clients: GET ?platform=android&arch=universal&build=12&channel=stable */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams, headers = { "Cache-Control": "no-store" };
  const platform = query.get("platform") as ClientPlatform, arch = (query.get("arch") || undefined) as ClientArch | undefined;
  const channel = query.get("channel") || "stable", rawBuild = query.get("build");
  const build = rawBuild && /^\d{1,10}$/.test(rawBuild) ? Number(rawBuild) : null;
  if (!clientPlatforms.includes(platform) || (arch && !clientArchitectures.includes(arch)) || (channel !== "stable" && channel !== "beta") || (rawBuild && build === null)) {
    return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400, headers });
  }
  try {
    const decision = await updateCheck({ platform, arch, channel, build });
    return NextResponse.json({ ...decision, downloadPath: downloadPath(platform, decision.latest?.arch) }, { headers });
  } catch {
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
