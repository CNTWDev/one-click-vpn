import { NextResponse } from "next/server";
import { currentUser } from "../../../../server/auth";
import { findDevice, listConnectionProfiles, type Protocol } from "../../../../server/control-db";
import { issueScheduledConnectionProfile, publicProfile } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ profiles: (await listConnectionProfiles({ userId: user.id })).map(publicProfile) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const deviceId = cleanText(body.deviceId, 128);
    const regionId = cleanText(body.regionId, 128) || undefined;
    const device = await findDevice(deviceId);
    if (!device || device.user_id !== user.id) return jsonError("Access device not found", 404);
    const protocol = cleanText(body.protocol, 32) as Protocol || "wireguard";
    if (protocol !== "wireguard" && protocol !== "openvpn") return jsonError("Unsupported access protocol");
    const clientPrivateKey = cleanText(body.clientPrivateKey, 128) || undefined;
    const profile = await issueScheduledConnectionProfile({ actorUserId: user.id, deviceId, regionId, protocol, transport: "udp", clientPrivateKey });
    return NextResponse.json({ profile: publicProfile(profile) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create connection profile", 409);
  }
}
