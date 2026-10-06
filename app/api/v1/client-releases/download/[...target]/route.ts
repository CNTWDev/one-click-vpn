import { NextResponse } from "next/server";
import { clientArchitectures, clientPlatforms, releaseFor, type ClientArch, type ClientPlatform } from "../../../../../../shared/client-releases";
import { publicReleases } from "../../../../../../server/client-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Permanent download link: /download/android, /download/windows/arm64 (the Portal proxies /download/*
 * here). It always redirects to the newest published stable build, so shared links never go stale.
 */
export async function GET(request: Request, context: { params: Promise<{ target: string[] }> }) {
  const [platform, arch, extra] = (await context.params).target;
  const channel = new URL(request.url).searchParams.get("channel") || "stable", headers = { "Cache-Control": "no-store" };
  if (extra || !clientPlatforms.includes(platform as ClientPlatform) || (arch && !clientArchitectures.includes(arch as ClientArch)) || (channel !== "stable" && channel !== "beta")) {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404, headers });
  }
  try {
    const release = releaseFor(await publicReleases(), platform as ClientPlatform, arch as ClientArch | undefined, channel);
    if (!release) return NextResponse.json({ code: "CLIENT_NOT_RELEASED" }, { status: 404, headers });
    return NextResponse.redirect(release.url, { status: 302, headers });
  } catch {
    return NextResponse.json({ code: "CLIENT_RELEASES_UNAVAILABLE" }, { status: 503, headers });
  }
}
