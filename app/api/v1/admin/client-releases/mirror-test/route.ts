import { mirrorTest } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs the download mirror check step by step (administrators only). */
export async function POST(request: Request) {
  return releaseRoute(request, (actor) => mirrorTest(actor));
}
