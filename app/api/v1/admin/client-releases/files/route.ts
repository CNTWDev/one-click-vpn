import { receiveUpload } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Local storage upload: PUT the installer bytes with ?platform&arch&version&build&fileName.
 * Returns the storage key plus the SHA-256 and size the Controller recorded.
 */
export function PUT(request: Request) {
  return releaseRoute(request, (actor) => receiveUpload(actor, new URL(request.url).searchParams, request.body), { rawBody: true });
}
