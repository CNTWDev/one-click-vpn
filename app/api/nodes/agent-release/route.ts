import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { agentReleaseVersion } from "../../../../server/bootstrap";
import { jsonError } from "../../../../server/http";

export const runtime = "nodejs";
export async function GET() {
  if (!(await currentUser())) return jsonError("Authentication required", 401);
  return NextResponse.json({ version: agentReleaseVersion() }, { headers: { "Cache-Control": "no-store" } });
}
