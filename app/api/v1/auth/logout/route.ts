import { NextResponse } from "next/server";
import { apiUser, revokeBearerSession } from "../../../../../server/device-auth";
import { addAudit } from "../../../../../server/db";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await apiUser(request);
  if (!user) return jsonError("Authentication required", 401);
  await revokeBearerSession(request);
  await addAudit({ actorUserId: user.id, action: "api.auth.logout" });
  return new NextResponse(null, { status: 204 });
}
