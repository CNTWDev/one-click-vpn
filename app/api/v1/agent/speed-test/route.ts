import { NextResponse } from "next/server";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { agentTokenFromRequest, authenticateAgent } from "../../../../../server/agent";
import { recordSpeedTest } from "../../../../../server/speed-test";

export const runtime = "nodejs";

/** A speed test result from the Agent (2.20+): one the Controller asked for, or its own before/after tuning pair. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = agentTokenFromRequest(request, cleanText(body.token, 512));
    if (!(await authenticateAgent(nodeId, token, request))) return jsonError("Invalid agent credentials", 401);
    return NextResponse.json({ ok: await recordSpeedTest(nodeId, body) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to record speed test");
  }
}
