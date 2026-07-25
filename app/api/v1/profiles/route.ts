import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { findDevice, listConnectionProfiles, type Protocol } from "../../../../server/control-db";
import { issueConnectionProfile, publicProfile, protocolForPlatform } from "../../../../server/control-plane";
import { cleanText, jsonError, readJson } from "../../../../server/http";

export const runtime = "nodejs";

const protocols = new Set<Protocol>(["wireguard", "openvpn", "ikev2"]);

export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  const url = new URL(request.url);
  const deviceId = cleanText(url.searchParams.get("deviceId"), 128) || undefined;
  const status = cleanText(url.searchParams.get("status"), 20) as "issued" | "active" | "expired" | "revoked" | undefined;
  return NextResponse.json({ profiles: listConnectionProfiles({ deviceId, status }).map(publicProfile) });
}

export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    const deviceId = cleanText(body.deviceId, 128);
    const nodeId = cleanText(body.nodeId, 128);
    const protocol = cleanText(body.protocol, 32) as Protocol;
    const transport = cleanText(body.transport, 32) || undefined;
    const device = findDevice(deviceId);
    if (!device || !deviceId || !nodeId || !protocols.has(protocol)) return jsonError("deviceId, nodeId, and a supported protocol are required");
    if (!protocolForPlatform(device.platform, protocol)) return jsonError("Protocol is not supported by the device platform");
    const profile = issueConnectionProfile({ actorUserId: user.id, deviceId, nodeId, protocol, transport });
    return NextResponse.json({ profile: publicProfile(profile) }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to issue profile", 409);
  }
}
