import { NextResponse } from "next/server";
import { agentDomainStatus, setAgentDomain } from "../../../../../server/agent-domain";
import { addAudit } from "../../../../../server/db";
import { jsonError, readJson } from "../../../../../server/http";
import { requestAdmin } from "../../../../../server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await agentDomainStatus());
}

export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    await setAgentDomain(body.domain);
    const status = await agentDomainStatus();
    await addAudit({ actorUserId: admin.id, action: "agent_domain.updated", targetType: "controller", targetId: "primary", metadata: { origin: status.origin } });
    return NextResponse.json(status);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save Agent domain");
  }
}
