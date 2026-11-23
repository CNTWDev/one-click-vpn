import { transitionRelease } from "../../../../../../server/client-releases";
import { releaseRoute } from "../handler";
import { settleRelease } from "../../../../../../server/telegram-actions";
import { rolloutAction, settleRollout } from "../../../../../../server/rollout-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** body.action: publish | promote | withdraw | delete | rollout | freeze | resume; with scope "build": freeze | resume | full | withdraw for every installer of the build. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return releaseRoute(request, async (actor, body) => {
    if (body.scope === "build") return rolloutAction(actor, id, body.action);
    const release = await transitionRelease(actor, id, body.action, body);
    if (release && typeof release === "object" && "build" in release && ["rollout", "freeze", "resume", "withdraw"].includes(String(body.action)))
      void settleRollout(String(release.platform), Number(release.build), "已在 Console 处理").catch(() => undefined);
    // Promoted or withdrawn here: the Telegram "promote" button for this version closes once no beta build is left.
    if (release && typeof release === "object" && "version" in release) void settleRelease(String(release.version)).catch(() => undefined);
    return release;
  });
}
