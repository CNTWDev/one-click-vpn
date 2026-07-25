import { NextResponse } from "next/server";
import { requestUser } from "../../../../../../server/request-auth";
import { expireConnectionProfile, findConnectionProfile, findDevice } from "../../../../../../server/control-db";
import { activateProfile, issueConnectionProfile, publicProfile } from "../../../../../../server/control-plane";
import { jsonError } from "../../../../../../server/http";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await requestUser(_request);
  if (!user) return jsonError("Authentication required", 401);
  const { id } = await context.params;
  try {
    const oldProfile = findConnectionProfile(id);
    if (!oldProfile) return jsonError("Profile not found", 404);
    const device = findDevice(oldProfile.device_id);
    if (!device) return jsonError("Device not found", 404);
    const next = issueConnectionProfile({ actorUserId: user.id, deviceId: oldProfile.device_id, nodeId: oldProfile.node_id, protocol: oldProfile.protocol, transport: oldProfile.transport });
    const activated = oldProfile.status === "active" ? activateProfile(next.id, user.id) : next;
    expireConnectionProfile(oldProfile.id);
    return NextResponse.json({ profile: publicProfile(activated) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to rotate profile", 409);
  }
}
