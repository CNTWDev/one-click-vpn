import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { activateProfile, publicProfile } from "../../../../../../server/control-plane";
import { findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  try {
    const existing = await findConnectionProfile(id);
    const device = existing ? await findDevice(existing.device_id) : null;
    if (!existing || !device || device.user_id !== user.id) return jsonError("Profile not found", 404);
    const profile = await activateProfile(id, user.id);
    return NextResponse.json({ profile: publicProfile(profile) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to activate profile", 409);
  }
}
