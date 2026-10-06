import { transitionRelease } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** body.action: publish | promote | withdraw | delete */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return releaseRoute(request, (actor, body) => transitionRelease(actor, id, body.action, body));
}
