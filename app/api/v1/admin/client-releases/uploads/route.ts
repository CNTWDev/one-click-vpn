import { requestUpload } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns a 15-minute presigned PUT URL; installer bytes never pass through the Controller. */
export function POST(request: Request) {
  return releaseRoute(request, (actor, body) => requestUpload(actor, body));
}
