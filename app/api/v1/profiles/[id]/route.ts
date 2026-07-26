import { NextResponse } from "next/server";
import { requestUser } from "../../../../../server/request-auth";
import { findConnectionProfile } from "../../../../../server/control-db";
import { publicProfile } from "../../../../../server/control-plane";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  if (!profile) return jsonError("Profile not found", 404);
  return NextResponse.json({ profile: publicProfile(profile) });
}
