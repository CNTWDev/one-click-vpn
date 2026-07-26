import { NextResponse } from "next/server";
import { requestUser } from "../../../../../server/request-auth";
import { findConnectionProfile, findDevice } from "../../../../../server/control-db";
import { publicProfile } from "../../../../../server/control-plane";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  const profile = await findConnectionProfile(id);
  const device = profile ? await findDevice(profile.device_id) : null;
  if (!profile || !device || device.user_id !== user.id) return jsonError("Profile not found", 404);
  return NextResponse.json({ profile: publicProfile(profile) });
}
