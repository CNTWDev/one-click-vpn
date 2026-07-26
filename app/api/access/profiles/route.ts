import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { findDevice } from "../../../../server/control-db";
import { issueConnectionProfile, publicProfile } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const deviceId = cleanText(body.deviceId, 128);
    const nodeId = cleanText(body.nodeId, 128);
    const device = await findDevice(deviceId);
    if (!device || device.user_id !== user.id) return jsonError("Access device not found", 404);
    if (!nodeId) return jsonError("A node is required");
    const profile = await issueConnectionProfile({ actorUserId: user.id, deviceId, nodeId, protocol: "wireguard", transport: "udp" });
    return NextResponse.json({ profile: publicProfile(profile) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create connection profile", 409);
  }
}
