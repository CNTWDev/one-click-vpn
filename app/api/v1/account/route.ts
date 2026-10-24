import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { jsonError } from "../../../../server/http";
import { portalAccount } from "../../../../server/portal-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json(await portalAccount(user.id));
}
