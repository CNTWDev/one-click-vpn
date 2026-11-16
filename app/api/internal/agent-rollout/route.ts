import { NextResponse } from "next/server";
import { addAudit } from "../../../../server/db";
import { isRolloutRequest, rolloutPlan, rolloutStatus, startRollout } from "../../../../server/agent-rollout";
import { jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

const ids = (value: unknown) => (Array.isArray(value) ? value : []).filter((id): id is string => typeof id === "string" && /^[\w-]{1,128}$/.test(id)).slice(0, 500);

/** Used only by one-click-update.sh on this host (scripts/agent-rollout.mjs): plan, upgrade, status. */
export async function POST(request: Request) {
  if (!isRolloutRequest(request)) return jsonError("Not found", 404);
  try {
    const body = await readJson(request);
    if (body.step === "plan") return NextResponse.json(await rolloutPlan());
    if (body.step === "upgrade") {
      const results = await startRollout(ids(body.nodeIds));
      await addAudit({ action: "nodes.agent_rollout.queued", targetType: "node_fleet", metadata: { results, via: "one-click-update" } });
      return NextResponse.json({ results });
    }
    if (body.step === "status") return NextResponse.json({ actions: await rolloutStatus(ids(body.actionIds)) });
    return jsonError("Unknown step");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Agent rollout failed");
  }
}
