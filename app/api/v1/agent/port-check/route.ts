import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { agentTokenFromRequest, authenticateAgent } from "../../../../../server/agent";
import { recordPortCheck } from "../../../../../server/port-check";

export const runtime = "nodejs";

/** The Agent's packet counts for a manual port check. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    if (!(await authenticateAgent(nodeId, token, request))) return jsonError("Invalid agent credentials", 401);
    const accepted = await recordPortCheck(nodeId, cleanText(body.id, 64), body.results, cleanText(body.error, 500));
    return NextResponse.json({ ok: accepted });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to record port check");
  }
}
