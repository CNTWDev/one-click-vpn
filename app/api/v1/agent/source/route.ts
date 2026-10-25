import { NextResponse } from "next/server";
import { agentTokenFromRequest, authenticateAgent } from "../../../../../server/agent";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { agentRelease } from "../../../../../server/agent-self-upgrade";

export const runtime = "nodejs";

/** The Controller's Agent release, for an Agent that upgrades itself (it checks the SHA-256 it was given). */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    if (!(await authenticateAgent(nodeId, token, request))) return jsonError("Invalid agent credentials", 401);
    const { source, version, sha256 } = agentRelease();
    return NextResponse.json({ source, version, sha256 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Agent source is unavailable");
  }
}
