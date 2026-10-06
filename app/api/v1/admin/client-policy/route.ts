import { setMinimumBuild } from "../../../../../server/client-releases";
import { releaseRoute } from "../client-releases/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sets the oldest client build still allowed to sign in and connect. */
export function PUT(request: Request) {
  return releaseRoute(request, (actor, body) => setMinimumBuild(actor, body));
}
