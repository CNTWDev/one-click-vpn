import { transitionRelease } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";
import { settleRelease } from "../../../../../../server/telegram-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** body.action: publish | promote | withdraw | delete */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return releaseRoute(request, async (actor, body) => {
    const release = await transitionRelease(actor, id, body.action, body);
    // Promoted or withdrawn here: the Telegram "promote" button for this version closes once no beta build is left.
    if (release && typeof release === "object" && "version" in release) void settleRelease(String(release.version)).catch(() => undefined);
    return release;
  });
}
