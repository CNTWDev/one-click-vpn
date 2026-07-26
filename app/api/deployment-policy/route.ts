import { NextResponse } from "next/server";
import { currentUser } from "../../../server/auth";
import { deploymentPolicyOverview, rolloutStandardPolicy } from "../../../server/deployment-policy";
import { cleanText, jsonError, readJson } from "../../../server/http";

export const runtime = "nodejs";

export async function GET() {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  return NextResponse.json(await deploymentPolicyOverview());
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const mode = cleanText(body.mode, 20) as "canary" | "batch";
    if (mode !== "canary" && mode !== "batch") return jsonError("mode must be canary or batch");
    const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.filter((value): value is string => typeof value === "string").slice(0, 100) : undefined;
    return NextResponse.json({ rollout: await rolloutStandardPolicy({ actorUserId: user.id, mode, limit: Number(body.limit || 25), nodeIds }) }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to start policy rollout", 409);
  }
}
