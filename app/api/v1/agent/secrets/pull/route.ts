import { NextResponse } from "next/server";
import { authenticateAgent } from "../../../../../../server/agent";
import { cleanText, jsonError, readJson } from "../../../../../../server/http";
import { readSecretMaterial } from "../../../../../../server/secret-materials";

export const runtime = "nodejs";

/** An Agent can read only a secret that was explicitly bound to its node. */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const nodeId = cleanText(body.nodeId, 128);
    const token = cleanText(body.token, 512);
    const secretId = cleanText(body.secretId, 160);
    if (!(await authenticateAgent(nodeId, token))) return jsonError("Invalid agent credentials", 401);
    const value = await readSecretMaterial(secretId, nodeId);
    if (!value) return jsonError("Secret is unavailable for this node", 404);
    return NextResponse.json({ value });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to retrieve node secret");
  }
}
