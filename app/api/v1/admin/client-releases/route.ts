import { createRelease, releaseOverview, ReleaseError } from "../../../../../server/client-releases";
import { releaseRoute } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return releaseRoute(request, async (actor) => {
    if (actor.kind !== "admin") throw new ReleaseError("ADMIN_REQUIRED", 403);
    return releaseOverview();
  });
}

/** Registers a draft. The Controller downloads the public URL once to record its real SHA-256 and size. */
export function POST(request: Request) {
  return releaseRoute(request, (actor, body) => createRelease(actor, body));
}
